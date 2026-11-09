import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { SingleOwnerConflict } from "../src/errors.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

class Counter extends Actor {
  static override readonly actorType = "SingleOwnerStartCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }
}

const aliveThreshold = 60_000

let runtime: SolidObjectsRuntime | undefined
let stopRuntime: (() => Promise<void>) | undefined

afterEach(async () => {
  await stopRuntime?.()
  stopRuntime = undefined
  await runtime?.close()
  runtime = undefined
})

async function installedRuntime(): Promise<SolidObjectsRuntime> {
  runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    singleOwner: true,
    processAliveThresholdMilliseconds: aliveThreshold,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
  })
  runtime.register(Counter)
  await runtime.install()
  return runtime
}

function start(target: SolidObjectsRuntime): Promise<void> {
  const controller = new AbortController()
  const running = target.run(controller.signal)
  stopRuntime = async () => {
    controller.abort()
    await running
  }
  return running
}

async function insertProcess(options: {
  id: string
  heartbeatAgeMilliseconds: number
  shutdownState: "running" | "draining" | "stopped"
}): Promise<void> {
  await runtime!.settings.database.transaction(async (connection) => {
    const now = await connection.nowMilliseconds()
    await connection.run(
      `INSERT INTO solid_objects_processes
       (id, kind, hostname, host_process_id, metadata, started_at_ms, heartbeat_at_ms, shutdown_state)
       VALUES (?, 'worker', 'other-host', 4242, '{}', ?, ?, ?)`,
      [
        options.id,
        now - options.heartbeatAgeMilliseconds,
        now - options.heartbeatAgeMilliseconds,
        options.shutdownState,
      ],
    )
  })
}

async function shutdownStateOf(id: string): Promise<string | undefined> {
  const row = await runtime!.settings.database.connection((connection) =>
    connection.get<{ shutdown_state: string }>(
      "SELECT shutdown_state FROM solid_objects_processes WHERE id = ?",
      [id],
    ),
  )
  return row?.shutdown_state
}

async function waitForStatus(options: {
  status: () => Promise<string>
  expected: string
  timeoutMilliseconds: number
}): Promise<string> {
  const deadline = performance.now() + options.timeoutMilliseconds
  let status = await options.status()
  while (status !== options.expected && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    status = await options.status()
  }
  return status
}

describe("singleOwner start", () => {
  it.each(["running", "draining"] as const)(
    "refuses to start while another %s process row is alive",
    async (shutdownState) => {
      const target = await installedRuntime()
      await insertProcess({ id: "other", heartbeatAgeMilliseconds: 1_000, shutdownState })

      const failure = await target.run(new AbortController().signal).catch((error) => error)

      expect(failure).toBeInstanceOf(SingleOwnerConflict)
      expect(failure.message).toContain(
        "singleOwner refuses to start, because another process row is alive",
      )
      expect(failure.message).toContain("worker other on other-host with process ID 4242")
      expect(failure.processes).toEqual([
        expect.objectContaining({ id: "other", kind: "worker", hostProcessId: 4242 }),
      ])
      expect(failure.processes[0].staleAt.getTime()).toBe(
        failure.processes[0].heartbeatAt.getTime() + aliveThreshold,
      )
      expect(await shutdownStateOf("other")).toBe(shutdownState)
    },
  )

  it("starts again once the other process has stopped", async () => {
    const target = await installedRuntime()
    await insertProcess({ id: "other", heartbeatAgeMilliseconds: 1_000, shutdownState: "running" })
    await expect(target.run(new AbortController().signal)).rejects.toThrow(SingleOwnerConflict)
    await target.settings.database.transaction((connection) =>
      connection.run("UPDATE solid_objects_processes SET shutdown_state = 'stopped'"),
    )

    const message = await target.ref(Counter, "after").send.increment()
    void start(target)

    expect(
      await waitForStatus({
        status: () => message.status(),
        expected: "completed",
        timeoutMilliseconds: 2_000,
      }),
    ).toBe("completed")
  })

  it("ignores the process rows of its own synchronous callers", async () => {
    const target = await installedRuntime()
    expect(await target.ref(Counter, "caller").increment()).toBe(1)

    const message = await target.ref(Counter, "caller").send.increment()
    void start(target)

    expect(
      await waitForStatus({
        status: () => message.status(),
        expected: "completed",
        timeoutMilliseconds: 2_000,
      }),
    ).toBe("completed")
  })

  it("releases a stale process once at start, so its claimed message runs at once", async () => {
    const target = await installedRuntime()
    const message = await target.ref(Counter, "stale").send.increment()
    await insertProcess({
      id: "crashed",
      heartbeatAgeMilliseconds: aliveThreshold + 1_000,
      shutdownState: "running",
    })
    expect(await target.repository.claim("crashed")).toBeDefined()

    void start(target)

    expect(
      await waitForStatus({
        status: () => message.status(),
        expected: "completed",
        timeoutMilliseconds: 2_000,
      }),
    ).toBe("completed")
    expect(await shutdownStateOf("crashed")).toBe("stopped")
  })
})

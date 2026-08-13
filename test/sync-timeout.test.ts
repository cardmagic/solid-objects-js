import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import type { InstrumentationEvent } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { SyncTimeout } from "../src/errors.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

class TimeoutActor extends Actor {
  static override readonly actorType = "TimeoutActor"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("synchronous timeout diagnostics", () => {
  it("describes an activation and earlier message blocking the invocation", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({ instrumentation: (event) => events.push(event) })
    await runtime.install()
    const actor = TimeoutActor.ref("blocked")
    const blocker = await actor.send.increment()
    await runtime.repository.registerProcess("blocking-worker", "worker")
    const claimed = await runtime.repository.claim("blocking-worker")
    expect(claimed?.message.id).toBe(blocker.id)

    const error = await captureTimeout(() => actor.with({ timeoutMilliseconds: 1 }).increment())

    expect(error.details).toMatchObject({
      actorType: TimeoutActor.actorType,
      actorId: "blocked",
      operation: "increment",
      sequence: 2n,
      status: "ready",
      waitingOn: "activationHeld",
      activation: {
        ownerId: "blocking-worker",
        generation: expect.any(BigInt),
        expiresAt: expect.any(Date),
        process: {
          kind: "worker",
          shutdownState: "running",
        },
      },
      blocker: {
        messageId: blocker.id,
        sequence: 1n,
        operation: "increment",
        status: "claimed",
      },
    })
    expect(error.message).toContain("waitingOn=activationHeld")
    expect(error.messageReference.id).toBe(error.details.messageId)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "solid_objects.sync.timeout",
          attributes: expect.objectContaining({
            messageId: error.details.messageId,
            waitingOn: "activationHeld",
            activationOwnerId: "blocking-worker",
          }),
        }),
      ]),
    )

    await runtime.settings.database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("processes")} SET heartbeat_at_ms = 0 WHERE id = ?`,
        ["blocking-worker"],
      ),
    )
    await runtime.repository.cleanupStaleProcesses()
    expect(await error.messageReference.wait({ timeoutMilliseconds: 1_000 })).toBe(2)
  })

  it("starts the deadline before durable enqueue", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const enqueue = runtime.repository.enqueue.bind(runtime.repository)
    vi.spyOn(runtime.repository, "enqueue").mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return enqueue(input)
    })

    const error = await captureTimeout(() =>
      TimeoutActor.ref("delayed-enqueue").with({ timeoutMilliseconds: 1 }).increment(),
    )

    expect(error.details.waitingOn).toBe("readyUnclaimed")
    expect(await error.messageReference.wait({ timeoutMilliseconds: 1_000 })).toBe(1)
  })

  it("identifies a scheduled message that is not yet available", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const message = await TimeoutActor.ref("scheduled")
      .send.with({ availableAt: new Date(Date.now() + 60_000) })
      .increment()

    const error = await captureTimeout(() => message.wait({ timeoutMilliseconds: 1 }))

    expect(error.details.status).toBe("ready")
    expect(error.details.waitingOn).toBe("notYetAvailable")
    expect(error.details.blocker).toBeNull()
  })

  it("rejects invalid timeout values before invoking", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await expect(
      TimeoutActor.ref("invalid").with({ timeoutMilliseconds: -1 }).increment(),
    ).rejects.toThrow("timeoutMilliseconds must be a non-negative number")
  })

  it("does not assist execution when the timeout is zero", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    const error = await captureTimeout(() =>
      TimeoutActor.ref("immediate").with({ timeoutMilliseconds: 0 }).increment(),
    )

    expect(error.details.waitingOn).toBe("readyUnclaimed")
    expect(await error.messageReference.status()).toBe("ready")
    expect(await error.messageReference.wait({ timeoutMilliseconds: 1_000 })).toBe(1)
  })
})

function configuredRuntime(
  overrides: { instrumentation?: (event: InstrumentationEvent) => void } = {},
): SolidObjectsRuntime {
  const configured = configureSolidObjects({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    syncPollingIntervalMilliseconds: 1,
    ...overrides,
  })
  configured.register(TimeoutActor)
  return configured
}

async function captureTimeout(operation: () => Promise<unknown>): Promise<SyncTimeout> {
  try {
    await operation()
  } catch (error) {
    expect(error).toBeInstanceOf(SyncTimeout)
    return error as SyncTimeout
  }
  throw new Error("expected invocation to time out")
}

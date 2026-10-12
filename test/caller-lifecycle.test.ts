import { afterEach, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import type { InstrumentationEvent } from "../src/configuration.js"
import { mysql } from "../src/database/mysql.js"
import { postgresql } from "../src/database/postgresql.js"
import { sqlite } from "../src/database/sqlite.js"
import { ActorDestroyed } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { Worker } from "../src/worker.js"

class CallerCounter extends Actor {
  static override readonly actorType = "CallerCounter"
  static beforeCommit: (label: string) => Promise<void> = async () => {}
  static deactivated: () => void = () => {}
  count = 0

  async increment(options: { label: string }): Promise<number> {
    this.count += 1
    this.emit("caller-effect", { arguments: { label: options.label } })
    await CallerCounter.beforeCommit(options.label)
    return this.count
  }

  override onDeactivate(): void {
    CallerCounter.deactivated()
  }
}

let runtime: SolidObjectsRuntime
let controller: AbortController | undefined
let running: Promise<void> | undefined
const events: InstrumentationEvent[] = []

afterEach(async () => {
  controller?.abort()
  await running
  await runtime?.resetForTesting()
  await runtime?.close()
  vi.restoreAllMocks()
  events.length = 0
  controller = undefined
  running = undefined
  CallerCounter.beforeCommit = async () => {}
  CallerCounter.deactivated = () => {}
})

async function setup(options: { maxMessagesPerActivationPass?: number } = {}): Promise<void> {
  const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
  const database = connectionString?.startsWith("postgres")
    ? postgresql({ connectionString })
    : connectionString?.startsWith("mysql")
      ? mysql({ connectionString })
      : sqlite({ path: ":memory:" })
  runtime = configure({
    database,
    tableNamePrefix: "caller_test_",
    authorizeMessage: () => true,
    authorizeAdministration: () => true,
    broadcast: async () => {},
    maxAttempts: 1,
    instrumentation: (event) => events.push(event),
    ...options,
  })
  runtime.register(CallerCounter)
  runtime.registerEffect("caller-effect", async () => {})
  await runtime.install()
  await runtime.repository.resetForTesting()
}

async function effectLabels(): Promise<string[]> {
  const rows = await runtime.settings.database.connection((connection) =>
    connection.all<{ arguments: string }>(
      `SELECT arguments FROM ${runtime.repository.table("effects")}`,
    ),
  )
  return rows.map((row) => (JSON.parse(row.arguments) as { label: string }).label).sort()
}

it.each([50, 1])(
  "preserves effects while callers overlap with pass limit %i",
  async (passLimit) => {
    await setup({ maxMessagesPerActivationPass: passLimit })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const idlePass = Promise.withResolvers<void>()
    let executing = false
    let deactivatedDuringTurn = false
    CallerCounter.beforeCommit = async (label) => {
      if (label !== "second") return
      executing = true
      entered.resolve()
      await release.promise
      executing = false
    }
    CallerCounter.deactivated = () => {
      if (executing) deactivatedDuringTurn = true
    }
    const runOnce = Worker.prototype.runOnce
    vi.spyOn(Worker.prototype, "runOnce").mockImplementation(async function (
      this: Worker,
      options,
    ) {
      const count = await runOnce.call(this, options)
      if (count === 0) idlePass.resolve()
      return count
    })
    const reference = CallerCounter.ref("shared")
    const first = await reference.send.increment({ label: "first" })
    const second = reference.increment({ label: "second" })
    let third: Promise<number> | undefined
    try {
      await beforeDeadline(entered.promise)
      third = reference.increment({ label: "third" })
      await beforeDeadline(idlePass.promise)
    } finally {
      release.resolve()
      await Promise.all([second, third])
    }
    expect(await first.result()).toBe(1)
    expect(await second).toBe(2)
    expect(await third).toBe(3)
    expect(await effectLabels()).toEqual(["first", "second", "third"])
    expect(deactivatedDuringTurn).toBe(false)
    expect(events.filter((event) => event.name === "solid_objects.activation.lost")).toEqual([])
    expect(events.filter((event) => event.name === "solid_objects.message.completed")).toHaveLength(
      3,
    )
    expect(
      events
        .filter((event) => event.name === "solid_objects.message.started")
        .map((event) => event.attempt),
    ).toEqual([1, 1, 1])
  },
)

it.each(["worker", "effectWorker", "reminderScheduler", "broadcastWorker"] as const)(
  "restores the process record before an idle %s resumes",
  async (role) => {
    await setup()
    const worker = runtime[role]()
    try {
      expect(await worker.runOnce()).toBe(0)
      await runtime.settings.database.connection(async (connection) => {
        const now = await connection.nowMilliseconds()
        await connection.run(
          `UPDATE ${runtime.repository.table("processes")} SET heartbeat_at_ms = ? WHERE id = ?`,
          [now - runtime.settings.processAliveThresholdMilliseconds - 1, worker.processId],
        )
      })
      await runtime.cleanupProcesses()
      await runtime.settings.database.connection(async (connection) => {
        const now = await connection.nowMilliseconds()
        await connection.run(
          `UPDATE ${runtime.repository.table("processes")} SET stopped_at_ms = ? WHERE id = ?`,
          [now - 8 * 86_400_000, worker.processId],
        )
      })
      expect((await runtime.retention.prune({ target: "processes" })).count).toBe(1)
      expect(await worker.runOnce()).toBe(0)
      expect((await runtime.repository.listProcesses()).rows).toEqual([
        expect.objectContaining({ id: worker.processId, shutdown_state: "running" }),
      ])
    } finally {
      await worker.stop()
    }
    expect(await worker.runOnce()).toBe(0)
    expect((await runtime.repository.listProcesses()).rows[0]?.shutdown_state).toBe("stopped")
  },
)

it("allows synchronous calls to different actors to execute together", async () => {
  await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const labels: string[] = []
  CallerCounter.beforeCommit = async (label) => {
    labels.push(label)
    if (labels.length === 2) entered.resolve()
    await release.promise
  }
  const first = CallerCounter.ref("first").increment({ label: "first" })
  const second = CallerCounter.ref("second").increment({ label: "second" })
  try {
    await beforeDeadline(entered.promise)
  } finally {
    release.resolve()
    await Promise.all([first, second])
  }
  expect(await first).toBe(1)
  expect(await second).toBe(1)
  expect(await effectLabels()).toEqual(["first", "second"])
  const processIds = (await runtime.repository.listProcesses()).rows.map((row) => row.id).sort()
  expect(processIds).toHaveLength(2)
  CallerCounter.beforeCommit = async () => {}
  expect(
    await Promise.all([
      CallerCounter.ref("first").increment({ label: "first-again" }),
      CallerCounter.ref("second").increment({ label: "second-again" }),
    ]),
  ).toEqual([2, 2])
  expect((await runtime.repository.listProcesses()).rows.map((row) => row.id).sort()).toEqual(
    processIds,
  )
  await runtime.resetForTesting()
  expect(await CallerCounter.ref("reset").increment({ label: "reset" })).toBe(1)
  expect((await runtime.repository.listProcesses()).rows).toHaveLength(1)
})

async function beforeDeadline(operation: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("caller did not reach the barrier")), 3000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

it("discards a stopped caller that finishes after test reset", async () => {
  await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  CallerCounter.beforeCommit = async (label) => {
    if (label !== "interrupted") return
    entered.resolve()
    await release.promise
  }
  const reference = CallerCounter.ref("reset-during-call").with({ timeoutMilliseconds: 1000 })
  const interrupted = reference.increment({ label: "interrupted" }).catch((error: unknown) => error)
  try {
    await beforeDeadline(entered.promise)
    await runtime.resetForTesting()
  } finally {
    release.resolve()
    await interrupted
  }

  expect(await interrupted).toBeInstanceOf(ActorDestroyed)
  expect(await reference.increment({ label: "after-reset" })).toBe(1)
  expect(await reference.increment({ label: "reused" })).toBe(2)
  expect(await effectLabels()).toEqual(["after-reset", "reused"])
})

it.each(["stopped", "pruned"])(
  "recovers a %s caller registration after runtime shutdown",
  async (state) => {
    await setup()
    const reference = CallerCounter.ref("retained-process")
    expect(await reference.increment({ label: "before" })).toBe(1)
    const caller = (await runtime.repository.listProcesses()).rows[0]!
    controller = new AbortController()
    running = runtime.run(controller.signal)
    await vi.waitFor(async () =>
      expect((await runtime.repository.listProcesses()).rows.length).toBeGreaterThan(1),
    )
    await runtime.settings.database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      await connection.run(
        `UPDATE ${runtime.repository.table("processes")} SET heartbeat_at_ms = ? WHERE id = ?`,
        [now - runtime.settings.processAliveThresholdMilliseconds - 1, caller.id],
      )
    })
    await runtime.cleanupProcesses()
    expect(
      (await runtime.repository.listProcesses()).rows.find((row) => row.id === caller.id)
        ?.shutdown_state,
    ).toBe("stopped")
    if (state === "pruned") {
      await runtime.settings.database.connection(async (connection) => {
        const now = await connection.nowMilliseconds()
        await connection.run(
          `UPDATE ${runtime.repository.table("processes")} SET stopped_at_ms = ? WHERE id = ?`,
          [now - 8 * 86_400_000, caller.id],
        )
      })
      expect((await runtime.retention.prune({ target: "processes" })).count).toBe(1)
    }
    controller.abort()
    await running
    running = undefined
    expect(await reference.increment({ label: "after" })).toBe(2)
    expect(
      (await runtime.repository.listProcesses()).rows.find((row) => row.id === caller.id)
        ?.shutdown_state,
    ).toBe("running")
    expect(
      events
        .filter((event) => event.name === "solid_objects.message.started")
        .map((event) => event.attempt),
    ).toEqual([1, 1])
  },
)

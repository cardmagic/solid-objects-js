import { afterEach, expect, it } from "vitest"
import type { InstrumentationEvent } from "../src/configuration.js"
import { expectPortableAttributes } from "./support/portable-telemetry.js"
import { Actor } from "../src/actor.js"
import { mysql } from "../src/database/mysql.js"
import { postgresql } from "../src/database/postgresql.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { controlledDatabaseClock } from "./support/fenced-commit.js"

class RecoveryCounter extends Actor {
  static override readonly actorType = "RecoveryBackoffCounter"
  static beforeCommit: (label: string) => void = () => {}
  count = 0

  increment(options: { label: string }): number {
    this.count += 1
    this.emit("applied", { arguments: options })
    RecoveryCounter.beforeCommit(options.label)
    return this.count
  }
}

let events: InstrumentationEvent[]
let runtime: SolidObjectsRuntime
let clock: ReturnType<typeof controlledDatabaseClock>

afterEach(async () => {
  await runtime?.repository.resetForTesting()
  await runtime?.close()
  RecoveryCounter.beforeCommit = () => {}
})

async function setup(
  options: { retryDelayMilliseconds?: (attempt: number) => number; maxAttempts?: number } = {},
): Promise<void> {
  const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
  const database = connectionString?.startsWith("postgres")
    ? postgresql({ connectionString })
    : connectionString?.startsWith("mysql")
      ? mysql({ connectionString })
      : sqlite({ path: ":memory:" })
  clock = controlledDatabaseClock(database)
  events = []
  runtime = createRuntime({
    instrumentation: (event) => events.push(event),
    database: clock.database,
    tableNamePrefix: "backoff_test_",
    leaseDurationMilliseconds: 200,
    leaseRenewalIntervalMilliseconds: 50,
    maxAttempts: 1,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    ...options,
  })
  runtime.register(RecoveryCounter)
  runtime.registerEffect("applied", async () => {})
  await runtime.install()
  await runtime.repository.resetForTesting()
  RecoveryCounter.beforeCommit = (label) => {
    if (label === "slow") clock.advanceMilliseconds(201)
  }
}

async function remainingDelay(messageId: string): Promise<number> {
  return runtime.settings.database.connection(async (connection) => {
    const ready = await connection.get<{ available_at_ms: number | bigint }>(
      `SELECT available_at_ms FROM ${runtime.repository.table("ready_messages")} WHERE message_id = ?`,
      [messageId],
    )
    if (!ready) throw new Error("message has no ready membership")
    return Number(ready.available_at_ms) - (await connection.nowMilliseconds())
  })
}

it("recovers once immediately then backs off without blocking other actors or reordering", async () => {
  await setup()
  const worker = runtime.worker()
  const reference = runtime.ref(RecoveryCounter, "slow")
  const first = await reference.send.increment({ label: "slow" })
  const later = await reference.send.increment({ label: "later" })
  try {
    expect(await worker.runOnce()).toBe(1)
    expect(await worker.runOnce()).toBe(1)
    const other = await runtime.ref(RecoveryCounter, "other").send.increment({ label: "other" })
    expect(await worker.runOnce()).toBe(1)
    expect(await other.result()).toBe(1)
    expect(await first.status()).toBe("ready")
    expect(await later.status()).toBe("ready")
    expect(await remainingDelay(first.id)).toBe(1_000)
    expect((await reference.snapshot()).count).toBe(0)

    clock.advanceMilliseconds(999)
    expect(await worker.runOnce()).toBe(0)
    clock.advanceMilliseconds(1)
    expect(await worker.runOnce()).toBe(1)
    expect(await worker.runOnce()).toBe(0)
    expect(await remainingDelay(first.id)).toBe(2_000)
    expect(Number((await runtime.repository.findMessage(first.id))?.attempt_count)).toBe(3)

    RecoveryCounter.beforeCommit = () => {}
    clock.advanceMilliseconds(2_000)
    expect(await worker.runOnce()).toBe(2)
    expect(await first.result()).toBe(1)
    expect(await later.result()).toBe(2)
    const effects = await runtime.settings.database.connection((connection) =>
      connection.all<{ arguments: string }>(
        `SELECT arguments FROM ${runtime.repository.table("effects")}`,
      ),
    )
    expect(
      effects.map((effect) => (JSON.parse(effect.arguments) as { label: string }).label).sort(),
    ).toEqual(["later", "other", "slow"])
    expect(await first.status()).toBe("completed")
    const losses = events.filter((event) => event.name === "solid_objects.activation.lost")
    expect(losses.map((event) => event.attempt)).toEqual([1, 2, 3])
    expect(losses.every((event) => event.messageId === first.id)).toBe(true)
    losses.forEach(expectPortableAttributes)
  } finally {
    await worker.stop()
  }
})

it.each(["stop", "stale cleanup", "replacement worker"])(
  "preserves custom recovery delays through %s",
  async (recovery) => {
    const delayArguments: number[] = []
    await setup({
      retryDelayMilliseconds: (attempt) => {
        delayArguments.push(attempt)
        return attempt * 25
      },
    })
    const firstWorker = runtime.worker()
    const replacement = runtime.worker()
    const message = await runtime.ref(RecoveryCounter, "one").send.increment({ label: "slow" })
    try {
      await firstWorker.runOnce()
      await firstWorker.runOnce()
      if (recovery === "stop") await firstWorker.stop()
      if (recovery === "stale cleanup") {
        clock.advanceMilliseconds(runtime.settings.processAliveThresholdMilliseconds + 1)
        await runtime.repository.cleanupStaleProcesses()
      }
      expect(await replacement.runOnce()).toBe(0)
      expect(delayArguments).toEqual([1])
      expect(await remainingDelay(message.id)).toBe(25)
      expect(await message.status()).toBe("ready")
      await firstWorker.stop()
      expect(await remainingDelay(message.id)).toBe(25)

      clock.advanceMilliseconds(25)
      expect(await replacement.runOnce()).toBe(1)
      expect(await replacement.runOnce()).toBe(0)
      expect(delayArguments).toEqual([1, 2])
      expect(await remainingDelay(message.id)).toBe(50)
      expect(Number((await runtime.repository.findMessage(message.id))?.attempt_count)).toBe(3)
    } finally {
      await firstWorker.stop()
      await replacement.stop()
    }
  },
)

it("keeps handler failures terminal with one allowed attempt", async () => {
  await setup()
  RecoveryCounter.beforeCommit = () => {
    throw new Error("handler failed")
  }
  const worker = runtime.worker()
  try {
    const message = await runtime.ref(RecoveryCounter, "failure").send.increment({ label: "fail" })
    await worker.runOnce()
    expect(await message.status()).toBe("dead")
    expect(Number((await runtime.repository.findMessage(message.id))?.attempt_count)).toBe(1)
  } finally {
    await worker.stop()
  }
})

it("caps default recovery waits at sixty seconds without dead-lettering lease loss", async () => {
  await setup()
  const worker = runtime.worker()
  try {
    const message = await runtime
      .ref(RecoveryCounter, "persistent")
      .send.increment({ label: "slow" })
    await worker.runOnce()
    await worker.runOnce()
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      expect(await worker.runOnce()).toBe(0)
      expect(await remainingDelay(message.id)).toBe(delay)
      expect(await message.status()).toBe("ready")
      clock.advanceMilliseconds(delay)
      expect(await worker.runOnce()).toBe(1)
    }
  } finally {
    await worker.stop()
  }
})

it("uses total claims for recovery after an earlier handler failure", async () => {
  const delayArguments: number[] = []
  await setup({
    maxAttempts: 3,
    retryDelayMilliseconds: (attempt) => {
      delayArguments.push(attempt)
      return attempt * 25
    },
  })
  const worker = runtime.worker()
  try {
    const message = await runtime.ref(RecoveryCounter, "mixed").send.increment({ label: "slow" })
    RecoveryCounter.beforeCommit = () => {
      throw new Error("handler failed")
    }
    await worker.runOnce()
    expect(delayArguments).toEqual([1])
    clock.advanceMilliseconds(25)
    RecoveryCounter.beforeCommit = () => clock.advanceMilliseconds(201)
    await worker.runOnce()
    expect(await worker.runOnce()).toBe(0)
    expect(delayArguments).toEqual([1, 1])
    expect(await remainingDelay(message.id)).toBe(25)
    expect(Number((await runtime.repository.findMessage(message.id))?.attempt_count)).toBe(2)
    clock.advanceMilliseconds(25)
    RecoveryCounter.beforeCommit = () => {
      throw new Error("handler failed again")
    }
    await worker.runOnce()
    expect(await message.status()).toBe("dead")
    expect(Number((await runtime.repository.findMessage(message.id))?.attempt_count)).toBe(3)
  } finally {
    await worker.stop()
  }
})

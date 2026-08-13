import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import type { BroadcastEvent, SolidObjectsConfiguration } from "../src/configuration.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"

class Checkout extends Actor {
  static override readonly actorType = "Checkout"

  status = "open"
  effectResult: string | null = null

  checkout({ paymentId }: { paymentId: string }): void {
    this.status = "pending"
    this.emit("charge_payment", {
      arguments: { paymentId },
      onSuccess: "paymentSucceeded",
      onFailure: "paymentFailed",
    })
  }

  paymentSucceeded({ result }: { effectId: string; result: { receipt: string } }): void {
    this.status = "paid"
    this.effectResult = result.receipt
  }

  paymentFailed(): void {
    this.status = "failed"
  }
}

class DatabaseWriter extends Actor {
  static override readonly actorType = "DatabaseWriter"

  status = "open"

  finish({ recordId }: { recordId: string }): void {
    this.status = "finished"
    this.commitAction("write_record", { recordId })
  }
}

class Alarm extends Actor {
  static override readonly actorType = "Alarm"

  fired = 0

  arm(): void {
    this.schedule({ at: new Date(0) }).fire!()
  }

  fire(): void {
    this.fired += 1
  }
}

class ObservableCounter extends Actor {
  static override readonly actorType = "ObservableCounter"

  count = 0
  privateValue = "secret"

  increment(): void {
    this.count += 1
    this.privateValue = "changed"
  }

  override observables(): Record<string, unknown> {
    return { count: this.count }
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("durable effects", () => {
  it("runs an effect and delivers its success message", async () => {
    runtime = configuredRuntime()
    let effectContext:
      | {
          id: string
          attempt: number
          sourceMessageId: string
          actorType: string
          actorId: string
        }
      | undefined
    runtime.registerEffect("charge_payment", ({ paymentId }, context) => {
      effectContext = context
      return { receipt: `${paymentId}:${context.id}` }
    })
    await runtime.install()
    const checkout = Checkout.ref("order-1")

    await checkout.checkout({ paymentId: "payment-1" })
    expect(await runtime.effectWorker().runUntilIdle()).toBe(1)
    expect(await runtime.worker().runUntilIdle()).toBe(1)

    expect(await checkout.status).toBe("paid")
    expect(await checkout.effectResult).toMatch(/^payment-1:/)
    expect(effectContext).toMatchObject({
      attempt: 1,
      sourceMessageId: expect.any(String),
      actorType: Checkout.actorType,
      actorId: "order-1",
    })
  })

  it("marks unknown effects dead and delivers the failure message", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const checkout = Checkout.ref("order-2")

    await checkout.checkout({ paymentId: "payment-2" })
    expect(await runtime.effectWorker().runUntilIdle()).toBe(1)
    expect(await runtime.worker().runUntilIdle()).toBe(1)

    expect(await checkout.status).toBe("failed")
    const effect = await runtime.settings.database.connection((connection) =>
      connection.get<{
        status: string
      }>(`SELECT status FROM ${runtime?.repository.table("effects")}`),
    )
    expect(effect?.status).toBe("dead")
  })

  it("recovers an effect claimed by a stale process", async () => {
    runtime = configuredRuntime({ maxAttempts: 3 })
    runtime.registerEffect("charge_payment", () => ({ receipt: "recovered" }))
    await runtime.install()
    await Checkout.ref("order-3").checkout({ paymentId: "payment-3" })
    await abandonProcess("abandoned-effect", "effect_worker")
    expect(await runtime.repository.claimEffect("abandoned-effect")).toBeDefined()
    await staleProcess("abandoned-effect")

    expect(await runtime.effectWorker().runUntilIdle()).toBe(1)

    const effect = await runtime.settings.database.connection((connection) =>
      connection.get<{
        attempt_count: number | bigint
        status: string
      }>(`SELECT attempt_count, status FROM ${runtime?.repository.table("effects")}`),
    )
    expect(effect).toMatchObject({ attempt_count: 2n, status: "completed" })
  })
})

describe("commit actions", () => {
  it("commits application data atomically with actor state", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await runtime.settings.database.connection((connection) =>
      connection.run("CREATE TABLE application_records(id TEXT PRIMARY KEY) STRICT"),
    )
    let activationGeneration: bigint | undefined
    runtime.registerCommitAction("write_record", async ({ recordId }, context) => {
      activationGeneration = context.activationGeneration
      await context.connection.run("INSERT INTO application_records(id) VALUES (?)", [recordId])
    })
    const writer = DatabaseWriter.ref("writer")

    await writer.finish({ recordId: "record-1" })

    expect(await writer.status).toBe("finished")
    const record = await runtime.settings.database.connection((connection) =>
      connection.get<{
        id: string
      }>("SELECT id FROM application_records"),
    )
    expect(record?.id).toBe("record-1")
    expect(activationGeneration).toBeGreaterThan(0n)
  })

  it("rolls actor state back when a commit action fails", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    runtime.registerCommitAction("write_record", () => {
      throw new Error("application write failed")
    })
    await runtime.install()
    const writer = DatabaseWriter.ref("failed-writer")
    const message = await writer.send.finish({ recordId: "record-2" })

    await runtime.worker().runUntilIdle()

    expect(await message.status()).toBe("dead")
    expect(await writer.status).toBe("open")
  })
})

describe("reminders", () => {
  it("turns a due reminder into an actor message", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const alarm = Alarm.ref("wake-up")

    await alarm.arm()
    expect(await runtime.reminderScheduler().runUntilIdle()).toBe(1)
    expect(await runtime.worker().runUntilIdle()).toBe(1)

    expect(await alarm.fired).toBe(1)
  })

  it("recovers a reminder claimed by a stale process", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const alarm = Alarm.ref("recovered-alarm")
    await alarm.arm()
    await abandonProcess("abandoned-reminder", "reminder_scheduler")
    expect(await runtime.repository.claimReminder("abandoned-reminder")).toBeDefined()
    await staleProcess("abandoned-reminder")

    expect(await runtime.reminderScheduler().runUntilIdle()).toBe(1)
    expect(await runtime.worker().runUntilIdle()).toBe(1)
    expect(await alarm.fired).toBe(1)
  })

  it("pauses a reminder whose message no longer exists", async () => {
    runtime = configuredRuntime({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })
    await runtime.install()
    await Alarm.ref("obsolete-alarm").arm()
    await runtime.settings.database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("reminders")} SET operation = 'removedOperation'`,
      ),
    )

    expect(await runtime.reminderScheduler().runUntilIdle()).toBe(1)

    const reminder = await runtime.settings.database.connection((connection) =>
      connection.get<{
        status: string
        error: string
      }>(`SELECT status, error FROM ${runtime?.repository.table("reminders")}`),
    )
    expect(reminder?.status).toBe("paused")
    expect(JSON.parse(reminder?.error ?? "{}")).toMatchObject({ name: "UnknownOperation" })
  })
})

describe("observable broadcasts", () => {
  it("delivers only the explicit observable projection", async () => {
    const events: BroadcastEvent[] = []
    runtime = configuredRuntime({
      broadcast: async (event) => {
        events.push(event)
      },
    })
    await runtime.install()

    await ObservableCounter.ref("counter").increment()
    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorType: "ObservableCounter",
      actorId: "counter",
      observables: { count: 1 },
    })
    expect(events[0]?.observables).not.toHaveProperty("privateValue")
  })

  it("recovers a broadcast claimed by a stale process", async () => {
    const events: BroadcastEvent[] = []
    runtime = configuredRuntime({
      broadcast: async (event) => {
        events.push(event)
      },
    })
    await runtime.install()
    await ObservableCounter.ref("recovered-broadcast").increment()
    await abandonProcess("abandoned-broadcast", "broadcast_worker")
    expect(await runtime.repository.claimBroadcast("abandoned-broadcast")).toBeDefined()
    await staleProcess("abandoned-broadcast")

    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(events).toHaveLength(1)
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 2,
    ...overrides,
  })
}

async function abandonProcess(processId: string, kind: string): Promise<void> {
  await runtime?.repository.registerProcess(processId, kind)
}

async function staleProcess(processId: string): Promise<void> {
  await runtime?.settings.database.connection((connection) =>
    connection.run(
      `UPDATE ${runtime?.repository.table("processes")} SET heartbeat_at_ms = 0 WHERE id = ?`,
      [processId],
    ),
  )
}

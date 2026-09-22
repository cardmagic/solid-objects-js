import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import type { ReminderHandle } from "../src/types.js"

class Subscription extends Actor {
  static override readonly actorType = "cancel-subscriptions"

  status = "trialing"
  expirations = 0
  handle: ReminderHandle | null = null

  startTrial(): void {
    this.handle = this.schedule({ at: new Date(Date.now() + 3_600_000) }).trialExpired()
  }

  startRecurring(): void {
    this.handle = this.schedule({
      at: new Date(Date.now() - 1_000),
      everyMilliseconds: 60_000,
    }).trialExpired()
  }

  convertByName(): void {
    this.status = "active"
    this.unschedule("trialExpired")
  }

  convertByHandle(): void {
    this.status = "active"
    if (this.handle) this.unschedule(this.handle)
  }

  cancelThenReschedule(): void {
    this.unschedule("trialExpired")
    this.schedule({ at: new Date(Date.UTC(2031, 0, 1)) }).trialExpired()
  }

  cancelThenFail(): void {
    this.unschedule("trialExpired")
    throw new Error("turn failed")
  }

  cancelBadHandle(): void {
    this.unschedule({ nope: "x" } as unknown as ReminderHandle)
  }

  trialExpired(): void {
    this.expirations += 1
    this.status = "expired"
  }
}

class Shipment extends Actor {
  static override readonly actorType = "cancel-shipments"

  dispatch({ carrierIds }: { carrierIds: string[] }): void {
    for (const id of carrierIds) {
      this.schedule({ at: new Date(Date.now() + 3_600_000), key: id }).chaseCarrier({
        carrierId: id,
      })
    }
    this.schedule({ at: new Date(Date.now() + 3_600_000) }).audit()
  }

  shipped({ carrierId }: { carrierId: string }): void {
    this.unschedule("chaseCarrier", { key: carrierId })
  }

  stopChasing(): void {
    this.unscheduleAll("chaseCarrier")
  }

  chaseCarrier(_options: { carrierId: string }): void {}
  audit(): void {}
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

async function start(): Promise<SolidObjectsRuntime> {
  runtime = configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 1,
  })
  runtime.register(Subscription)
  runtime.register(Shipment)
  await runtime.install()
  return runtime
}

async function reminderNames(started: SolidObjectsRuntime): Promise<string[]> {
  const rows = await started.settings.database.connection((connection) =>
    connection.all<{ operation: string }>(
      `SELECT operation FROM solid_objects_reminders ORDER BY operation`,
    ),
  )
  return rows.map((row) => row.operation)
}

describe("reminder cancellation", () => {
  it("returns a handle naming the reminder", async () => {
    const started = await start()
    const reference = Subscription.ref("alice")
    await reference.startTrial()

    expect(await reference.handle).toEqual({ name: "trialExpired" })
    expect(await reminderNames(started)).toEqual(["trialExpired"])
  })

  it("cancels by name", async () => {
    const started = await start()
    const reference = Subscription.ref("alice")
    await reference.startTrial()
    await reference.convertByName()

    expect(await reminderNames(started)).toEqual([])
    expect(await reference.status).toBe("active")
  })

  it("cancels by handle", async () => {
    const started = await start()
    const reference = Subscription.ref("alice")
    await reference.startTrial()
    await reference.convertByHandle()

    expect(await reminderNames(started)).toEqual([])
  })

  it("stops a recurring reminder", async () => {
    const started = await start()
    const reference = Subscription.ref("alice")
    await reference.startRecurring()
    expect(await started.reminderScheduler().runOnce()).toBe(1)
    await reference.convertByName()

    expect(await reminderNames(started)).toEqual([])
    expect(await started.reminderScheduler().runOnce()).toBe(0)
  })

  it("cancelling an absent reminder is not an error", async () => {
    const started = await start()
    await Subscription.ref("alice").convertByName()

    expect(await reminderNames(started)).toEqual([])
  })

  it("a failed turn cancels nothing", async () => {
    const started = await start()
    const reference = Subscription.ref("alice")
    await reference.startTrial()
    await expect(reference.cancelThenFail()).rejects.toThrow()

    expect(await reminderNames(started)).toEqual(["trialExpired"])
  })

  it("cancel then schedule in one turn leaves the new time", async () => {
    const started = await start()
    const reference = Subscription.ref("alice")
    await reference.startTrial()
    await reference.cancelThenReschedule()

    const rows = await started.settings.database.connection((connection) =>
      connection.all<{ run_at_ms: number | bigint }>(
        `SELECT run_at_ms FROM solid_objects_reminders`,
      ),
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.run_at_ms)).toBe(Date.UTC(2031, 0, 1))
  })

  it("rejects a malformed handle", async () => {
    const started = await start()
    await expect(Subscription.ref("alice").cancelBadHandle()).rejects.toThrow()
    expect(await reminderNames(started)).toEqual([])
  })

  it("cancels one key and leaves its siblings", async () => {
    const started = await start()
    const reference = Shipment.ref("truck")
    await reference.dispatch({ carrierIds: ["a", "b", "c"] })
    await reference.shipped({ carrierId: "b" })

    expect(await reminderNames(started)).toEqual(["audit", "chaseCarrier:a", "chaseCarrier:c"])
  })

  it("cancels every key of one operation", async () => {
    const started = await start()
    const reference = Shipment.ref("truck")
    await reference.dispatch({ carrierIds: ["a", "b", "c"] })
    await reference.stopChasing()

    expect(await reminderNames(started)).toEqual(["audit"])
  })
})

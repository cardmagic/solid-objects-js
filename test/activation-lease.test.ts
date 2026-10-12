import { randomUUID } from "node:crypto"
import { postgresql } from "../src/database/postgresql.js"
import { mysql } from "../src/database/mysql.js"
import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import type { InstrumentationEvent } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"

class LeaseCounter extends Actor {
  static override readonly actorType = "LeaseCounter"
  static beforeCommit: () => void | Promise<void> = () => {}
  count = 0

  async increment(): Promise<number> {
    this.count += 1
    await LeaseCounter.beforeCommit()
    return this.count
  }
}

let runtime: SolidObjectsRuntime
const events: InstrumentationEvent[] = []

afterEach(async () => {
  await runtime?.close()
  events.length = 0
  LeaseCounter.beforeCommit = () => {}
})

async function setup(): Promise<void> {
  const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
  const database = connectionString?.startsWith("postgres")
    ? postgresql({ connectionString })
    : connectionString?.startsWith("mysql")
      ? mysql({ connectionString })
      : sqlite({ path: ":memory:" })
  runtime = configure({
    database,
    tableNamePrefix: `lease_${randomUUID().slice(0, 8)}_`,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    leaseDurationMilliseconds: 200,
    leaseRenewalIntervalMilliseconds: 50,
    maxAttempts: 1,
    instrumentation: (event) => events.push(event),
  })
  runtime.register(LeaseCounter)
  await runtime.install()
}

function blockFor(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

async function storedLease(): Promise<{
  activation_expires_at_ms: number | bigint
  activation_generation: number | bigint
}> {
  const row = await runtime.settings.database.connection((connection) =>
    connection.get<{
      activation_expires_at_ms: number | bigint
      activation_generation: number | bigint
    }>(
      `SELECT activation_expires_at_ms, activation_generation FROM ${runtime.repository.table("instances")}`,
    ),
  )
  if (!row) throw new Error("missing instance")
  return row
}

describe("activation lease recovery", () => {
  it("renews a kept activation across continuous short passes for five lease durations", async () => {
    await setup()
    const worker = runtime.worker()
    const reference = LeaseCounter.ref("continuous")
    LeaseCounter.beforeCommit = () => blockFor(30)
    const messages = []
    let firstExpiration = 0
    for (let index = 0; index < 34; index += 1) {
      messages.push(await reference.send.increment())
      await worker.runOnce()
      if (index === 0) firstExpiration = Number((await storedLease()).activation_expires_at_ms)
    }

    expect(events.filter((event) => event.name === "solid_objects.activation.lost")).toEqual([])
    expect(Number((await storedLease()).activation_expires_at_ms)).toBeGreaterThan(
      firstExpiration + 800,
    )
    expect(Number((await storedLease()).activation_generation)).toBe(1)
    for (const [index, message] of messages.entries()) {
      expect(await message.status()).toBe("completed")
      expect(await message.result()).toBe(index + 1)
      expect(
        Number((await runtime.repository.messageWithStatus(message.id))?.message.attempt_count),
      ).toBe(1)
    }
    expect(events.filter((event) => event.name === "solid_objects.message.completed")).toHaveLength(
      34,
    )
    await worker.stop()
  })

  it("renews between short turns in a single pass without timer ticks", async () => {
    await setup()
    const worker = runtime.worker()
    const messages = []
    for (let index = 0; index < 10; index += 1) {
      messages.push(await LeaseCounter.ref("draining").send.increment())
    }
    LeaseCounter.beforeCommit = () => blockFor(30)

    expect(await worker.runOnce()).toBe(10)
    expect(events.filter((event) => event.name === "solid_objects.activation.lost")).toEqual([])
    for (const message of messages) expect(await message.status()).toBe("completed")
    await worker.stop()
  })

  it("recovers an expired turn on the same worker with maxAttempts set to one", async () => {
    await setup()
    const worker = runtime.worker()
    const reference = LeaseCounter.ref("expired")
    const first = await reference.send.increment()
    const second = await reference.send.increment()
    LeaseCounter.beforeCommit = () => blockFor(220)

    await worker.runOnce()
    expect(await first.status()).not.toBe("completed")
    const instance = await runtime.settings.database.connection((connection) =>
      connection.get<{ state: string }>(
        `SELECT state FROM ${runtime.repository.table("instances")}`,
      ),
    )
    expect(JSON.parse(instance!.state)).toEqual({ count: 0 })
    expect(events.filter((event) => event.name === "solid_objects.activation.lost")).toHaveLength(1)
    LeaseCounter.beforeCommit = () => {}

    expect(await worker.runOnce()).toBe(2)
    expect(await first.result()).toBe(1)
    expect(await second.result()).toBe(2)
    expect(
      events.filter((event) => event.name === "solid_objects.recovery.reclaimed"),
    ).toHaveLength(1)
    expect(events.filter((event) => event.name === "solid_objects.message.failed")).toEqual([])
    expect(
      events
        .filter((event) => event.name === "solid_objects.message.started")
        .map((event) => [event.messageId, event.attempt]),
    ).toEqual([
      [first.id, 1],
      [first.id, 2],
      [second.id, 1],
    ])
    expect(
      Number((await runtime.repository.messageWithStatus(first.id))?.message.attempt_count),
    ).toBe(2)
    expect(events.filter((event) => event.name === "solid_objects.dead_letter.created")).toEqual([])
    expect(events.filter((event) => event.name === "solid_objects.message.completed")).toHaveLength(
      2,
    )
    await worker.stop()
  })

  it("preserves a second worker's takeover when the expired first turn returns", async () => {
    await setup()
    const firstWorker = runtime.worker()
    const secondWorker = runtime.worker()
    const reference = LeaseCounter.ref("takeover")
    const first = await reference.send.increment()
    const second = await reference.send.increment()
    LeaseCounter.beforeCommit = async () => {
      LeaseCounter.beforeCommit = () => {}
      blockFor(220)
      expect(await secondWorker.runOnce()).toBe(2)
    }

    await firstWorker.runOnce()
    expect(await first.result()).toBe(1)
    expect(await second.result()).toBe(2)
    expect(
      events.filter((event) => event.name === "solid_objects.recovery.reclaimed"),
    ).toHaveLength(1)
    expect(events.filter((event) => event.name === "solid_objects.message.failed")).toEqual([])
    expect(
      events
        .filter((event) => event.name === "solid_objects.message.started")
        .map((event) => [event.messageId, event.attempt]),
    ).toEqual([
      [first.id, 1],
      [first.id, 2],
      [second.id, 1],
    ])
    expect(
      Number((await runtime.repository.messageWithStatus(first.id))?.message.attempt_count),
    ).toBe(2)
    expect(events.filter((event) => event.name === "solid_objects.activation.lost")).toHaveLength(1)
    expect(events.filter((event) => event.name === "solid_objects.message.completed")).toHaveLength(
      2,
    )
    const third = await reference.send.increment()
    expect(await secondWorker.runOnce()).toBe(1)
    expect(await third.result()).toBe(3)
    await firstWorker.stop()
    await secondWorker.stop()
  })
})

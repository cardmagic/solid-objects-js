import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { postgresql } from "../src/database/postgresql.js"
import { mysql } from "../src/database/mysql.js"
import type { Database, DatabaseConnection } from "../src/database/types.js"
import { Unauthorized } from "../src/errors.js"

class Counter extends Actor {
  static override readonly actorType = "Counter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.testing.reset()
  await runtime?.close()
  runtime = undefined
})

describe("snapshotWithIncarnation", () => {
  it("returns the same fields as snapshot() plus instanceId, revision, and createdAtMs", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Counter)
    await runtime.install()

    const reference = runtime.ref(Counter, "c1")
    await reference.increment({ amount: 4 })

    const plain = await runtime.snapshot(reference)
    const withIncarnation = await runtime.snapshotWithIncarnation(reference)

    expect(withIncarnation.snapshot).toEqual(plain)
    expect(withIncarnation.instanceId).toEqual(expect.any(String))
    expect(withIncarnation.instanceId.length).toBeGreaterThan(0)
    expect(withIncarnation.revision).toEqual(expect.any(String))
    expect(withIncarnation.createdAtMs).toEqual(expect.any(Number))
    expect(withIncarnation.createdAtMs).toBeGreaterThan(0)
  })

  it("distinguishes identical snapshots recreated in the same database millisecond", async () => {
    const settings = configuredSettings()
    const now = Date.now()
    runtime = createRuntime({ ...settings, database: frozenClock(settings.database!, now) })
    runtime.register(Counter)
    await runtime.install()

    const reference = runtime.ref(Counter, "c1")
    await reference.increment({ amount: 1 })
    const first = await runtime.snapshotWithIncarnation(reference)

    await reference.destroy()
    await reference.increment({ amount: 1 })
    const second = await runtime.snapshotWithIncarnation(reference)

    expect(second.instanceId).not.toEqual(first.instanceId)
    expect(second.createdAtMs).toBe(now)
    expect(first.createdAtMs).toBe(now)
    expect(second.revision).toBe(first.revision)
    expect(second.snapshot).toEqual(first.snapshot)
    // Timestamp and revision equality cannot establish incarnation equality.
    const refreshed = await runtime.snapshotWithIncarnation(reference)
    expect(refreshed.instanceId).toBe(second.instanceId)
    expect(refreshed.instanceId).not.toBe(first.instanceId)
    await reference.increment()
    const advanced = await runtime.snapshotWithIncarnation(reference)
    expect(advanced.instanceId).toBe(second.instanceId)
    expect(BigInt(advanced.revision)).toBeGreaterThan(BigInt(second.revision))
  })

  it("uses the non-persisted sentinel only until the first durable enqueue", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Counter)
    await runtime.install()
    const reference = runtime.ref(Counter, "not-yet-created")
    expect(await runtime.snapshotWithIncarnation(reference)).toMatchObject({
      instanceId: "0",
      revision: "0",
      createdAtMs: 0,
    })
    await reference.increment()
    expect((await runtime.snapshotWithIncarnation(reference)).instanceId).not.toBe("0")
    await reference.destroy()
    expect((await runtime.snapshotWithIncarnation(reference)).instanceId).toBe("0")
  })

  it("honors authorizeQuery the same way snapshot() does", async () => {
    runtime = createRuntime(configuredSettings({ authorizeQuery: () => false }))
    runtime.register(Counter)
    await runtime.install()

    const reference = runtime.ref(Counter, "c1")

    await expect(runtime.snapshotWithIncarnation(reference)).rejects.toBeInstanceOf(Unauthorized)
  })
})

function configuredSettings(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsConfiguration {
  return {
    database: databaseForEnvironment(),
    tableNamePrefix: "incarnation_test_",
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 2,
    ...overrides,
  }
}

function databaseForEnvironment(): Database {
  const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
  if (connectionString?.startsWith("postgres")) return postgresql({ connectionString })
  if (connectionString?.startsWith("mysql")) return mysql({ connectionString })
  return sqlite({ path: ":memory:" })
}

function frozenClock(database: Database, now: number): Database {
  const wrap = (connection: DatabaseConnection): DatabaseConnection => ({
    run: connection.run.bind(connection),
    get: connection.get.bind(connection),
    all: connection.all.bind(connection),
    nowMilliseconds: async () => now,
  })
  return {
    family: database.family,
    schemaIdentity: database.schemaIdentity,
    transactionActive: () => database.transactionActive?.() ?? false,
    connection: (callback) => database.connection((connection) => callback(wrap(connection))),
    transaction: (callback, options) =>
      database.transaction((connection) => callback(wrap(connection)), options),
    close: () => database.close(),
  }
}

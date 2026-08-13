import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { postgresqlSql } from "../src/database/postgresql-sql.js"
import { postgresql, type PostgreSQLDatabase } from "../src/database/postgresql.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"
import type { RealtimeEnvelope } from "../src/browser/index.js"

const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
const describePostgreSQL = connectionString?.startsWith("postgresql:") ? describe : describe.skip

class PostgreSQLCounter extends Actor {
  static override readonly actorType = "PostgreSQLCounter"

  count = 0

  increment(): void {
    this.count += 1
  }
}

class PostgreSQLWorkflow extends Actor {
  static override readonly actorType = "PostgreSQLWorkflow"

  count = 0
  effectResult: string | null = null
  reminderResult: string | null = null

  start(): void {
    this.count += 1
    this.emit("echo", {
      arguments: { value: "effect" },
      onSuccess: "effectSucceeded",
    })
    this.schedule({ at: new Date(0) }).reminderFired!({ value: "reminder" })
  }

  effectSucceeded({ result }: { result: string }): void {
    this.effectResult = result
  }

  reminderFired({ value }: { value: string }): void {
    this.reminderResult = value
  }

  override observables(): Record<string, unknown> {
    return {
      count: this.count,
      effectResult: this.effectResult,
      reminderResult: this.reminderResult,
    }
  }
}

let runtime: SolidObjectsRuntime | undefined
let database: PostgreSQLDatabase | undefined

afterEach(async () => {
  try {
    await runtime?.testing.reset()
  } finally {
    await runtime?.close()
    runtime = undefined
    database = undefined
  }
})

describe("PostgreSQL SQL parameters", () => {
  it("preserves quoted question marks while numbering parameters", () => {
    expect(
      postgresqlSql(
        "SELECT '?' AS literal, $$?$$, data ?? 'ready', ? AS first /* ? */, ? AS second",
      ),
    ).toBe("SELECT '?' AS literal, $$?$$, data ? 'ready', $1 AS first /* ? */, $2 AS second")
  })

  it("rejects invalid pool configuration before connecting", () => {
    expect(() => postgresql({ connectionString: "" })).toThrow("must not be empty")
    expect(() =>
      postgresql({ connectionString: "postgresql:///example", maximumConnections: 0 }),
    ).toThrow("must be a positive safe integer")
  })
})

describePostgreSQL("PostgreSQL adapter", () => {
  it("installs and allocates ordered sequences under concurrent enqueue", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    database = postgresql({ connectionString, maximumConnections: 10 })
    runtime = configureSolidObjects({
      database,
      tableNamePrefix: "postgresql_test_",
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      workerCount: 2,
      pollingIntervalMilliseconds: 1,
      syncPollingIntervalMilliseconds: 1,
    })
    runtime.register(PostgreSQLCounter)
    await runtime.install()

    const integer = await database.connection((connection) =>
      connection.get<{ value: bigint }>("SELECT 9223372036854775807::bigint AS value"),
    )
    expect(integer?.value).toBe(9_223_372_036_854_775_807n)

    await Promise.all(
      Array.from({ length: 25 }, () => PostgreSQLCounter.ref("shared").send.increment()),
    )
    await runtime.testing.drain({ roles: ["actors"] })

    await expect(PostgreSQLCounter.ref("shared").snapshot()).resolves.toMatchObject({ count: 25 })
    const report = await runtime.doctor.run()
    expect(report.healthy).toBe(true)
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "schema", status: "pass" }),
        expect.objectContaining({
          name: "database",
          status: "pass",
          message: expect.stringMatching(/^PostgreSQL .+ meets the tested minimum$/),
        }),
        expect.objectContaining({ name: "roundTrip", status: "pass" }),
      ]),
    )
  })

  it("runs outboxes, reconciliation, and retention on PostgreSQL", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    database = postgresql({ connectionString, maximumConnections: 10 })
    runtime = configureSolidObjects({
      database,
      tableNamePrefix: "postgresql_test_",
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      authorizeAdministration: () => true,
      authorizeSubscription: () => true,
      pollingIntervalMilliseconds: 1,
      syncPollingIntervalMilliseconds: 1,
      messageRetentionMilliseconds: 1,
    })
    runtime.register(PostgreSQLWorkflow)
    runtime.registerEffect("echo", async ({ value }) => value)
    await runtime.install()
    const delivered: RealtimeEnvelope[] = []
    const session = runtime.realtime.connect({
      authorizationContext: {},
      send: (envelope) => {
        delivered.push(envelope)
      },
    })
    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: PostgreSQLWorkflow.actorType,
      actorId: "flow",
    })

    await PostgreSQLWorkflow.ref("flow").start()
    await runtime.testing.drain()

    await expect(PostgreSQLWorkflow.ref("flow").snapshot()).resolves.toMatchObject({
      count: 1,
      effectResult: "effect",
      reminderResult: "reminder",
    })
    expect(delivered.filter(({ kind }) => kind === "invalidation").length).toBeGreaterThan(1)
    await expect(
      runtime.reconciliation.statesFor({
        actorType: PostgreSQLWorkflow.actorType,
        actorIds: ["flow", "missing"],
      }),
    ).resolves.toEqual({
      flow: { count: 1, effectResult: "effect", reminderResult: "reminder" },
    })
    await expect(
      runtime.reconciliation.orphaned({
        actorType: PostgreSQLWorkflow.actorType,
        ownerIds: [],
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ actorId: "flow" })],
    })

    await database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("messages")} SET completed_at_ms = 0
         WHERE completed_at_ms IS NOT NULL`,
      ),
    )
    const preview = await runtime.retention.preview({ target: "messages" })
    expect(preview.count).toBeGreaterThan(0)
    await expect(runtime.retention.prune({ target: "messages" })).resolves.toEqual(preview)
  })
})

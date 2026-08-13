import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { postgresqlSql } from "../src/database/postgresql-sql.js"
import {
  PostgreSQLWakeUpAdapter,
  postgresql,
  postgresqlWakeUp,
  type PostgreSQLDatabase,
} from "../src/database/postgresql.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"
import type { RealtimeEnvelope } from "../src/browser/index.js"

const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
const describePostgreSQL = connectionString?.startsWith("postgresql:") ? describe : describe.skip

class PostgreSQLCounter extends Actor {
  static override readonly actorType = "PostgreSQLCounter"
  static activations = 0

  count = 0
  #activation = 0

  protected override onActivate(): void {
    this.#activation = ++PostgreSQLCounter.activations
  }

  increment(): void {
    this.count += 1
  }

  identity(): { activation: number; count: number } {
    return { activation: this.#activation, count: this.count }
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
let wakeUps: PostgreSQLWakeUpAdapter[] = []

afterEach(async () => {
  try {
    await runtime?.testing.reset()
  } finally {
    await runtime?.close()
    await database?.close()
    await Promise.all(wakeUps.map((wakeUp) => wakeUp.close()))
    runtime = undefined
    database = undefined
    wakeUps = []
    PostgreSQLCounter.activations = 0
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

  it("rejects invalid notification channels before connecting", () => {
    expect(() =>
      postgresqlWakeUp({
        connectionString: "postgresql:///example",
        channelPrefix: "not-valid",
      }),
    ).toThrow("channelPrefix must contain only letters, digits, and underscores")
  })

  it("creates its matching wake-up adapter", async () => {
    const standaloneDatabase = postgresql({ connectionString: "postgresql:///example" })
    const wakeUp = standaloneDatabase.wakeUp()

    expect(wakeUp).toBeInstanceOf(PostgreSQLWakeUpAdapter)

    await wakeUp.close()
    await standaloneDatabase.close()
  })
})

describePostgreSQL("PostgreSQL adapter", () => {
  it("wakes every role waiter through another PostgreSQL client", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    const listener = postgresqlWakeUp({
      connectionString,
      channelPrefix: "postgresql_test_wake_up",
    })
    const notifier = postgresqlWakeUp({
      connectionString,
      channelPrefix: "postgresql_test_wake_up",
    })
    wakeUps.push(listener, notifier)
    const actorWatches = await Promise.all([
      listener.watch("actors"),
      listener.watch("actors"),
      listener.watch("actors"),
    ])
    const effectWatch = await listener.watch("effects")
    const actorWaits = actorWatches
      .slice(0, 2)
      .map((watch) => watch.wait({ timeoutMilliseconds: 10_000 }))
    let effectResolved = false
    void effectWatch.wait({ timeoutMilliseconds: 10_000 }).then(() => {
      effectResolved = true
    })
    const startedAt = performance.now()

    await notifier.notify("actors")
    await Promise.all([...actorWaits, actorWatches[2]!.wait({ timeoutMilliseconds: 10_000 })])

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(effectResolved).toBe(false)
    await listener.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(effectResolved).toBe(true)
  })

  it("reconnects a listener after PostgreSQL closes its session", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    const failures: string[] = []
    const applicationName = `solid-objects-wake-up-reconnect-${process.pid}`
    const listener = postgresqlWakeUp({
      connectionString,
      applicationName,
      channelPrefix: "postgresql_test_reconnect",
      onListenerError: ({ operation }) => failures.push(operation),
    })
    const notifier = postgresqlWakeUp({
      connectionString,
      channelPrefix: "postgresql_test_reconnect",
    })
    wakeUps.push(listener, notifier)
    database = postgresql({ connectionString })
    const interruptedWatch = await listener.watch("actors")
    const interruptedWait = interruptedWatch.wait({ timeoutMilliseconds: 10_000 })

    const terminated = await database.connection((connection) =>
      connection.get<{ terminated: boolean }>(
        `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
         WHERE application_name = ? AND pid <> pg_backend_pid()`,
        [applicationName],
      ),
    )
    expect(terminated?.terminated).toBe(true)
    await interruptedWait

    const reconnectedWatch = await listener.watch("actors")
    const reconnectedWait = reconnectedWatch.wait({ timeoutMilliseconds: 10_000 })
    await notifier.notify("actors")
    await reconnectedWait

    expect(failures).toContain("connection")
  })

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
    PostgreSQLCounter.activations = 0
    const worker = runtime.worker()
    const cached = PostgreSQLCounter.ref("cached")
    await cached.send.increment()
    expect(await worker.runOnce()).toBe(1)
    const identity = await cached.send.identity()
    expect(await worker.runOnce()).toBe(1)
    expect(await identity.result()).toEqual({ activation: 1, count: 1 })
    await worker.stop()
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

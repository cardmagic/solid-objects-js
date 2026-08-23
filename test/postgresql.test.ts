import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { postgresqlSql } from "../src/database/postgresql-sql.js"
import {
  PostgreSQLWakeUpAdapter,
  postgresql,
  postgresqlWakeUp,
  type PostgreSQLDatabase,
} from "../src/database/postgresql.js"
import { configure, createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { receiveTransmitEnvelope, registerTransmit } from "../src/transmit.js"
import type { RealtimeEnvelope } from "../src/browser/index.js"
import { SyncTimeout } from "../src/errors.js"
import { DatabaseDeadlineExceeded } from "../src/errors.js"
import { withDatabaseDeadline } from "../src/database/deadline.js"
import type { JsonObject } from "../src/types.js"
import { createDashboard } from "../src/web/index.js"

const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
const describePostgreSQL = connectionString?.startsWith("postgresql:") ? describe : describe.skip
const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

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

class PostgreSQLMigratingActor extends Actor {
  static override readonly actorType = "PostgreSQLMigratingActor"
  static override readonly stateVersion = 2
  static migrationFails = true
  static override readonly migrations = [
    {
      from: 1,
      to: 2,
      migrate: (state: JsonObject): JsonObject => {
        if (PostgreSQLMigratingActor.migrationFails) throw new Error("broken migration")
        return state
      },
    },
  ]

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }
}

class TransmitProofCounter extends Actor {
  static override readonly actorType = "TransmitProofCounter"

  count = 0
  applied: number[] = []

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    this.applied = [...this.applied, amount]
    this.transmit().increment!({ amount })
    return this.count
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
    PostgreSQLMigratingActor.migrationFails = true
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
  it("stages, drains, and ingests transmit envelopes on PostgreSQL", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    const localDatabase = postgresql({ connectionString, maximumConnections: 5 })
    const serverDatabase = postgresql({ connectionString, maximumConnections: 5 })
    const settings = {
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      pollingIntervalMilliseconds: 1,
      syncPollingIntervalMilliseconds: 1,
      maxAttempts: 8,
      retryDelayMilliseconds: () => 0,
      logger: quietLogger,
    }
    const local = createRuntime({
      database: localDatabase,
      tableNamePrefix: "transmit_local_",
      ...settings,
    })
    const server = createRuntime({
      database: serverDatabase,
      tableNamePrefix: "transmit_server_",
      ...settings,
    })
    try {
      let failuresRemaining = 1
      registerTransmit({
        runtime: local,
        deliver: async (envelope) => {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1
            throw new Error("network down")
          }
          await receiveTransmitEnvelope({ runtime: server, envelope })
          await receiveTransmitEnvelope({ runtime: server, envelope })
        },
      })
      server.register(TransmitProofCounter)
      await local.install()
      await server.install()

      const actorId = `proof-${crypto.randomUUID()}`
      const counter = local.ref(TransmitProofCounter, actorId)
      await counter.increment({ amount: 1 })
      await counter.increment({ amount: 2 })
      await local.testing.drain({ roles: ["actors", "effects"], maxPasses: 20 })
      await server.testing.drain({ roles: ["actors"] })

      await expect(server.ref(TransmitProofCounter, actorId).snapshot()).resolves.toEqual({
        count: 3,
        applied: [1, 2],
      })
    } finally {
      await local.testing.reset()
      await server.testing.reset()
      await local.close()
      await server.close()
      await localDatabase.close()
      await serverDatabase.close()
    }
  })

  it("enforces and clears database deadlines", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    database = postgresql({ connectionString, maximumConnections: 1 })

    const startedAt = performance.now()
    await expect(
      withDatabaseDeadline({ timeoutMilliseconds: 50 }, () =>
        database!.connection((connection) => connection.get("SELECT pg_sleep(1)")),
      ),
    ).rejects.toBeInstanceOf(DatabaseDeadlineExceeded)
    expect(performance.now() - startedAt).toBeLessThan(500)

    await expect(
      database.connection((connection) =>
        connection.get<{ statement_timeout: string; lock_timeout: string }>(
          "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout",
        ),
      ),
    ).resolves.toEqual({ statement_timeout: "0", lock_timeout: "0" })
  })

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
    let effectResult: boolean | void | undefined
    void effectWatch.wait({ timeoutMilliseconds: 10_000 }).then((result) => {
      effectResult = result
    })
    const startedAt = performance.now()

    await notifier.notify("actors")
    await expect(
      Promise.all([...actorWaits, actorWatches[2]!.wait({ timeoutMilliseconds: 10_000 })]),
    ).resolves.toEqual([true, true, true])

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(effectResult).toBeUndefined()
    await listener.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(effectResult).toBe(false)
  })

  it("distinguishes a PostgreSQL wake-up from a polling timeout", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    const listener = postgresqlWakeUp({
      connectionString,
      channelPrefix: "postgresql_test_wait_result",
    })
    const notifier = postgresqlWakeUp({
      connectionString,
      channelPrefix: "postgresql_test_wait_result",
    })
    wakeUps.push(listener, notifier)

    const timedOutWatch = await listener.watch("actors")
    await expect(timedOutWatch.wait({ timeoutMilliseconds: 1 })).resolves.toBe(false)
    const notifiedWatch = await listener.watch("actors")
    const notified = notifiedWatch.wait({ timeoutMilliseconds: 10_000 })
    await notifier.notify("actors")

    await expect(notified).resolves.toBe(true)
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
    await expect(interruptedWait).resolves.toBe(false)

    const reconnectedWatch = await listener.watch("actors")
    const reconnectedWait = reconnectedWatch.wait({ timeoutMilliseconds: 10_000 })
    await notifier.notify("actors")
    await expect(reconnectedWait).resolves.toBe(true)

    expect(failures).toContain("connection")
  })

  it("installs and allocates ordered sequences under concurrent enqueue", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    database = postgresql({ connectionString, maximumConnections: 10 })
    runtime = configure({
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

    const scheduled = await PostgreSQLCounter.ref("scheduled-timeout")
      .send.with({ availableAt: new Date(Date.now() + 60_000) })
      .increment()
    const timeout = await captureSyncTimeout(() => scheduled.wait({ timeoutMilliseconds: 100 }))
    expect(timeout.details).toMatchObject({ status: "ready", waitingOn: "notYetAvailable" })

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

  it("restores failed actor setup without consuming an attempt", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    database = postgresql({ connectionString, maximumConnections: 5 })
    runtime = configure({
      database,
      tableNamePrefix: "postgresql_test_",
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      logger: quietLogger,
    })
    runtime.register(PostgreSQLMigratingActor)
    await runtime.install()
    const message = await PostgreSQLMigratingActor.ref("migration").send.increment()
    await database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("instances")} SET state_version = 1
         WHERE actor_type = ? AND actor_id = ?`,
        [PostgreSQLMigratingActor.actorType, "migration"],
      ),
    )
    const worker = runtime.worker()

    expect(await worker.runOnce()).toBe(0)

    expect(await message.status()).toBe("ready")
    const stored = await runtime.repository.findMessage(message.id)
    expect(Number(stored?.attempt_count)).toBe(0)
    PostgreSQLMigratingActor.migrationFails = false
    expect(await worker.runOnce()).toBe(1)
    await expect(message.result()).resolves.toBe(1)
    await worker.stop()
  })

  it("runs outboxes, reconciliation, and retention on PostgreSQL", async () => {
    if (!connectionString) throw new Error("PostgreSQL connection string is required")
    database = postgresql({ connectionString, maximumConnections: 10 })
    runtime = configure({
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
    const dashboard = createDashboard({ runtime, mountPath: "/" })
    const dashboardResponse = await dashboard.fetch(
      new Request("http://example.test/instances?actor_id=low"),
      dashboardContext(),
    )
    expect(dashboardResponse.status).toBe(200)
    expect(await dashboardResponse.text()).toContain("flow")
  })
})

function dashboardContext() {
  const values = new Map<string, string>()
  return {
    authorizationContext: {},
    session: {
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => {
        values.set(key, value)
      },
    },
  }
}

async function captureSyncTimeout(operation: () => Promise<unknown>): Promise<SyncTimeout> {
  try {
    await operation()
  } catch (error) {
    expect(error).toBeInstanceOf(SyncTimeout)
    return error as SyncTimeout
  }
  throw new Error("expected invocation to time out")
}

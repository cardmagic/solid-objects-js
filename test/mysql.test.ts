import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { mysql, mysqlSql, type MySQLDatabase } from "../src/database/mysql.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
const describeMySQL = connectionString?.startsWith("mysql:") ? describe : describe.skip

class MySQLWorkflow extends Actor {
  static override readonly actorType = "MySQLWorkflow"
  static activations = 0
  count = 0
  effectResult: string | null = null
  reminderResult: string | null = null
  #activation = 0

  protected override onActivate(): void {
    this.#activation = ++MySQLWorkflow.activations
  }

  increment(): void {
    this.count += 1
  }

  identity(): { activation: number; count: number } {
    return { activation: this.#activation, count: this.count }
  }

  start(): void {
    this.count += 1
    this.emit("echo", { arguments: { value: "effect" }, onSuccess: "effectSucceeded" })
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
let database: MySQLDatabase | undefined

afterEach(async () => {
  try {
    await runtime?.testing.reset()
  } finally {
    await runtime?.close()
    await database?.close()
    runtime = undefined
    database = undefined
    MySQLWorkflow.activations = 0
  }
})

describe("MySQL SQL compatibility", () => {
  it("translates portable conflict clauses", () => {
    expect(mysqlSql("INSERT INTO records(id) VALUES (?) ON CONFLICT(id) DO NOTHING")).toBe(
      "INSERT IGNORE INTO records(id) VALUES (?)",
    )
    expect(
      mysqlSql(
        "INSERT INTO records(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
      ),
    ).toBe(
      "INSERT INTO records(id, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    )
  })

  it("rejects invalid pool configuration before connecting", () => {
    expect(() => mysql({ connectionString: "" })).toThrow("must not be empty")
    expect(() =>
      mysql({ connectionString: "mysql://localhost/example", maximumConnections: 0 }),
    ).toThrow("must be a positive safe integer")
  })
})

describeMySQL("MySQL adapter", () => {
  it("runs mailbox, outbox, reconciliation, retention, and doctor workflows", async () => {
    if (!connectionString) throw new Error("MySQL connection string is required")
    database = mysql({ connectionString, maximumConnections: 10 })
    runtime = configureSolidObjects({
      database,
      tableNamePrefix: "mysql_test_",
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      authorizeAdministration: () => true,
      authorizeSubscription: () => true,
      pollingIntervalMilliseconds: 1,
      syncPollingIntervalMilliseconds: 1,
      messageRetentionMilliseconds: 1,
    })
    runtime.register(MySQLWorkflow)
    runtime.registerEffect("echo", async ({ value }) => value)
    await runtime.install()
    await runtime.install()

    await Promise.all(
      Array.from({ length: 25 }, () => MySQLWorkflow.ref("shared").send.increment()),
    )
    await runtime.testing.drain({ roles: ["actors"] })
    await expect(MySQLWorkflow.ref("shared").snapshot()).resolves.toMatchObject({ count: 25 })
    MySQLWorkflow.activations = 0
    const worker = runtime.worker()
    const cached = MySQLWorkflow.ref("cached")
    await cached.send.increment()
    expect(await worker.runOnce()).toBe(1)
    const identity = await cached.send.identity()
    expect(await worker.runOnce()).toBe(1)
    expect(await identity.result()).toEqual({ activation: 1, count: 1 })
    await worker.stop()

    await MySQLWorkflow.ref("flow").start()
    await runtime.testing.drain()
    await expect(MySQLWorkflow.ref("flow").snapshot()).resolves.toMatchObject({
      count: 1,
      effectResult: "effect",
      reminderResult: "reminder",
    })
    await expect(
      runtime.reconciliation.statesFor({
        actorType: MySQLWorkflow.actorType,
        actorIds: ["flow", "missing"],
      }),
    ).resolves.toEqual({
      flow: { count: 1, effectResult: "effect", reminderResult: "reminder" },
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
    const report = await runtime.doctor.run()
    expect(report.healthy, JSON.stringify(report.checks, null, 2)).toBe(true)
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "schema", status: "pass" }),
        expect.objectContaining({ name: "database", status: "pass" }),
        expect.objectContaining({ name: "roundTrip", status: "pass" }),
      ]),
    )
  })
})

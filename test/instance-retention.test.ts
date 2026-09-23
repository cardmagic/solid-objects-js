import { afterEach, expect, it } from "vitest"
import { mysql } from "../src/database/mysql.js"
import { postgresql } from "../src/database/postgresql.js"
import { sqlite } from "../src/database/sqlite.js"
import type {
  Database,
  DatabaseConnection,
  DatabaseTransactionOptions,
} from "../src/database/types.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { SCHEMA_VERSIONS } from "../src/schema.js"

const PREFIX = "retention_index_test_"
const DAY = 24 * 60 * 60 * 1_000
type RetentionQueryPlanRow = { key?: string | null; detail?: string; "QUERY PLAN"?: string }
let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  try {
    await runtime?.repository.resetForTesting()
  } finally {
    await runtime?.close()
    runtime = undefined
  }
})

it.each(["fresh installation", "version-nine upgrade", "interrupted upgrade"])(
  "uses the retention index to find rare expired instances after %s",
  async (scenario) => {
    const database = new RetentionPlanDatabase(testDatabase())
    runtime = createRuntime({
      database,
      tableNamePrefix: PREFIX,
      authorizeAdministration: () => true,
      instanceRetentionByActorType: { RetentionActor: DAY },
    })
    await runtime.install()
    await database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      for (let offset = 0; offset < 2_000; offset += 250) {
        const parameters = Array.from({ length: 250 }, (_, index) => {
          const identity = String(offset + index).padStart(8, "0")
          return [identity, "RetentionActor", identity, "{}", 1, now - 3 * DAY, now]
        })
        await connection.run(
          `INSERT INTO ${PREFIX}instances
         (id, actor_type, actor_id, state, state_version, created_at_ms, updated_at_ms)
         VALUES ${parameters.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
          parameters.flat(),
        )
      }
      await connection.run(`UPDATE ${PREFIX}instances SET updated_at_ms = ? WHERE id = ?`, [
        now - 2 * DAY,
        "00001999",
      ])
    })
    if (scenario === "version-nine upgrade") {
      await database.connection(async (connection) => {
        const tableClause = database.family === "mysql" ? ` ON ${PREFIX}instances` : ""
        await connection.run(`DROP INDEX ${PREFIX}instances_retention${tableClause}`)
      })
    }
    if (scenario === "version-nine upgrade" || scenario === "interrupted upgrade") {
      await database.connection((connection) =>
        connection.run(`DELETE FROM ${PREFIX}schema_migrations WHERE version = 10`),
      )
      await runtime.install()
      await runtime.install()
    }
    await database.connection((connection) =>
      connection.run(
        `${database.family === "mysql" ? "ANALYZE TABLE" : "ANALYZE"} ${PREFIX}instances`,
      ),
    )

    expect(await runtime.retention.preview({ target: "instances" })).toEqual({
      target: "instances",
      count: 1,
    })
    expect(await runtime.retention.prune({ target: "instances" })).toEqual({
      target: "instances",
      count: 1,
    })
    expect(database.previewPlans).toHaveLength(1)
    expect(database.pruningPlans).toHaveLength(2)
    const planColumn =
      database.family === "mysql" ? "key" : database.family === "sqlite" ? "detail" : "QUERY PLAN"
    for (const plan of [...database.previewPlans, ...database.pruningPlans]) {
      expect(plan.map((row) => String(row[planColumn])).join("\n")).toContain(
        `${PREFIX}instances_retention`,
      )
    }
    const remaining = await database.connection((connection) =>
      connection.get<{ count: number | bigint }>(
        `SELECT COUNT(*) AS count FROM ${PREFIX}instances`,
      ),
    )
    expect(Number(remaining?.count)).toBe(1_999)
    const versions = await database.connection((connection) =>
      connection.all<{ version: number | bigint }>(
        `SELECT version FROM ${PREFIX}schema_migrations ORDER BY version`,
      ),
    )
    expect(versions.map(({ version }) => Number(version))).toEqual([...SCHEMA_VERSIONS])
  },
  30_000,
)

it("preserves distinct actor policies and unconfigured instances with the retention index", async () => {
  const database = testDatabase()
  runtime = createRuntime({
    database,
    tableNamePrefix: PREFIX,
    authorizeAdministration: () => true,
    instanceRetentionByActorType: { RetentionActor: DAY, OtherRetentionActor: 2 * DAY },
  })
  await runtime.install()
  await database.transaction(async (connection) => {
    const now = await connection.nowMilliseconds()
    const cases = [
      { identity: "expired", actorType: "RetentionActor", age: 2 * DAY },
      { identity: "recent", actorType: "RetentionActor", age: DAY / 2 },
      { identity: "other-expired", actorType: "OtherRetentionActor", age: 3 * DAY },
      { identity: "other-retained", actorType: "OtherRetentionActor", age: 1.5 * DAY },
      { identity: "unconfigured", actorType: "UnconfiguredActor", age: 3 * DAY },
    ]
    for (const { identity, actorType, age } of cases) {
      await connection.run(
        `INSERT INTO ${PREFIX}instances
         (id, actor_type, actor_id, state, state_version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [identity, actorType, identity, "{}", 1, now - 3 * DAY, now - age],
      )
    }
  })

  expect(await runtime.retention.preview({ target: "instances" })).toEqual({
    target: "instances",
    count: 2,
  })
  expect(await runtime.retention.prune({ target: "instances" })).toEqual({
    target: "instances",
    count: 2,
  })
  const remaining = await database.connection((connection) =>
    connection.all<{ id: string }>(`SELECT id FROM ${PREFIX}instances ORDER BY id`),
  )
  expect(remaining.map(({ id }) => id)).toEqual(["other-retained", "recent", "unconfigured"])
}, 30_000)

function testDatabase(): Database {
  const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
  if (!connectionString) return sqlite({ path: ":memory:" })
  if (connectionString.startsWith("mysql:")) return mysql({ connectionString })
  if (connectionString.startsWith("postgresql:")) return postgresql({ connectionString })
  throw new Error("instance retention tests require a mysql: or postgresql: database URL")
}

class RetentionPlanDatabase implements Database {
  readonly family: Database["family"]
  readonly schemaIdentity: string
  readonly previewPlans: RetentionQueryPlanRow[][] = []
  readonly pruningPlans: RetentionQueryPlanRow[][] = []

  constructor(private readonly database: Database) {
    this.family = database.family
    this.schemaIdentity = database.schemaIdentity
  }

  connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.database.connection((connection) => callback(this.recordingConnection(connection)))
  }

  transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
    options?: DatabaseTransactionOptions,
  ): Promise<Result> {
    return this.database.transaction(
      (connection) => callback(this.recordingConnection(connection)),
      options,
    )
  }

  close(): Promise<void> {
    return this.database.close()
  }

  private recordingConnection(connection: DatabaseConnection): DatabaseConnection {
    const explainStatement = {
      sqlite: "EXPLAIN QUERY PLAN",
      mysql: "EXPLAIN FORMAT=TRADITIONAL",
      postgresql: "EXPLAIN",
    }[this.family]
    const explain = (options: {
      sql: string
      parameters: Parameters<DatabaseConnection["all"]>[1]
    }) =>
      connection.all<RetentionQueryPlanRow>(
        `${explainStatement} ${options.sql}`,
        options.parameters,
      )

    return {
      run: (sql, parameters) => connection.run(sql, parameters),
      get: async <Row extends object>(
        ...[sql, parameters]: Parameters<DatabaseConnection["get"]>
      ) => {
        if (sql.startsWith(`SELECT COUNT(*) AS count FROM ${PREFIX}instances WHERE`)) {
          this.previewPlans.push(await explain({ sql, parameters }))
        }
        return connection.get<Row>(sql, parameters)
      },
      all: async <Row extends object>(
        ...[sql, parameters]: Parameters<DatabaseConnection["all"]>
      ) => {
        if (sql.startsWith(`SELECT id FROM ${PREFIX}instances WHERE`)) {
          this.pruningPlans.push(await explain({ sql, parameters }))
        }
        return connection.all<Row>(sql, parameters)
      },
      nowMilliseconds: () => connection.nowMilliseconds(),
    }
  }
}

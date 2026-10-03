import { afterEach, describe, expect, it } from "vitest"
import type { Database, DatabaseConnection, DatabaseFamily } from "../src/database/types.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("polling queries", () => {
  it("keeps ordered probes indexable without combining recovery paths", async () => {
    const database = sqlite({ path: ":memory:" })
    const installer = configuredRuntime(database)
    await installer.install()
    const statements: string[] = []
    runtime = configuredRuntime(new RecordingPostgreSQLDatabase(database, statements))

    await runtime.repository.claimEffect("effect-worker")
    await runtime.repository.claimReminder("reminder-worker")
    await runtime.repository.claimBroadcast("broadcast-worker")

    const pollingStatements = statements.filter((statement) =>
      /FROM solid_objects_(effects|reminders|broadcasts) /.test(statement),
    )
    expect(pollingStatements).toHaveLength(5)
    for (const statement of pollingStatements) expect(statement).not.toMatch(/\bJOIN\b/)
    expect(pollingStatements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /WHERE effects\.status = 'pending'.*ORDER BY effects\.available_at_ms, effects\.id LIMIT 1 FOR UPDATE SKIP LOCKED$/,
        ),
        expect.stringMatching(
          /WHERE reminders\.status = 'scheduled'.*reminders\.claimed_by IS NULL.*ORDER BY reminders\.run_at_ms, reminders\.id LIMIT 1$/,
        ),
        expect.stringMatching(
          /WHERE reminders\.status = 'scheduled'.*reminders\.claimed_by IS NOT NULL.*ORDER BY reminders\.run_at_ms, reminders\.id LIMIT 1$/,
        ),
        expect.stringMatching(
          /WHERE broadcasts\.status = 'pending'.*ORDER BY broadcasts\.available_at_ms, broadcasts\.id LIMIT 1$/,
        ),
        expect.stringMatching(
          /WHERE broadcasts\.status = 'processing'.*ORDER BY broadcasts\.available_at_ms, broadcasts\.id LIMIT 1$/,
        ),
      ]),
    )
    const recoveryProbes = pollingStatements.filter(
      (statement) => !statement.includes("FROM solid_objects_effects effects"),
    )
    for (const statement of recoveryProbes) expect(statement).not.toMatch(/FOR UPDATE/)
    const pendingBroadcast = pollingStatements.find((statement) =>
      statement.includes("broadcasts.status = 'pending'"),
    )
    expect(pendingBroadcast).not.toMatch(/broadcasts\.status = 'processing'/)
    const availableReminder = pollingStatements.find((statement) =>
      statement.includes("reminders.claimed_by IS NULL"),
    )
    expect(availableReminder).not.toMatch(/reminders\.claimed_by IS NOT NULL/)
  })

  it("finds SQLite recovery candidates through processing effects when most effects are complete", async () => {
    const database = sqlite({ path: ":memory:" })
    const queries: RecordedQuery[] = []
    runtime = configuredRuntime(new RecordingQueryDatabase(database, queries))
    await runtime.install()
    await database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      await connection.run(
        `INSERT INTO solid_objects_instances(id, actor_type, actor_id, state, state_version, created_at_ms, updated_at_ms)
         VALUES ('instance', 'Probe', 'one', '{}', 1, ?, ?)`,
        [now, now],
      )
      await connection.run(
        `INSERT INTO solid_objects_messages(id, request_id, instance_id, actor_type, actor_id, sequence, operation,
           delivery_mode, arguments, max_attempts, created_at_ms, updated_at_ms)
         VALUES ('message', 'request', 'instance', 'Probe', 'one', 1, 'run', 'async', '{}', 3, ?, ?)`,
        [now, now],
      )
      for (let index = 0; index < 3_000; index++) {
        const effectId = `effect-${String(index).padStart(4, "0")}`
        await connection.run(
          `INSERT INTO solid_objects_effects(id, message_id, instance_id, name, arguments, status, max_attempts, available_at_ms)
           VALUES (?, 'message', 'instance', 'work', '{}', 'completed', 3, ?)`,
          [effectId, now],
        )
        if (index < 2_700) continue
        await connection.run(
          `INSERT INTO solid_objects_effect_recoveries(effect_id, instance_id, recovery_operation, status_operation)
           VALUES (?, 'instance', 'recover', 'inspect')`,
          [effectId],
        )
      }
    })
    await database.connection((connection) => connection.run("ANALYZE"))
    const pollStatistics = await database.connection((connection) =>
      connection.get<{ stat: string }>(
        "SELECT stat FROM sqlite_stat1 WHERE idx = 'solid_objects_effects_poll'",
      ),
    )
    expect(pollStatistics?.stat.split(" ")[1]).toBe("3000")

    await runtime.repository.claimEffect("effect-worker")

    const candidates = queries.find((query) =>
      query.sql.includes("FROM solid_objects_effect_recoveries recoveries"),
    )
    expect(candidates).toBeDefined()
    const plan = await database.connection((connection) =>
      connection.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${candidates!.sql}`,
        candidates!.parameters,
      ),
    )
    const steps = plan.map((row) => row.detail)
    expect(steps[0]).toMatch(/^SEARCH effects USING INDEX solid_objects_effects_poll \(status=\?\)/)
    expect(steps.filter((step) => step.startsWith("SCAN "))).toEqual([])
  })
})

type QueryParameters = Parameters<DatabaseConnection["all"]>[1]

interface RecordedQuery {
  sql: string
  parameters: QueryParameters
}

class RecordingQueryDatabase implements Database {
  readonly family: DatabaseFamily
  readonly schemaIdentity: string

  constructor(
    private readonly database: Database,
    private readonly queries: RecordedQuery[],
  ) {
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
  ): Promise<Result> {
    return this.database.transaction((connection) => callback(this.recordingConnection(connection)))
  }

  transactionActive(): boolean {
    return this.database.transactionActive?.() ?? false
  }

  close(): Promise<void> {
    return this.database.close()
  }

  private recordingConnection(connection: DatabaseConnection): DatabaseConnection {
    return {
      run: (sql, parameters) => connection.run(sql, parameters),
      get: <Row extends object>(sql: string, parameters?: QueryParameters) =>
        connection.get<Row>(sql, parameters),
      all: <Row extends object>(sql: string, parameters?: QueryParameters) => {
        this.queries.push({ sql, parameters })
        return connection.all<Row>(sql, parameters)
      },
      nowMilliseconds: () => connection.nowMilliseconds(),
    }
  }
}

class RecordingPostgreSQLDatabase implements Database {
  readonly family = "postgresql" as const
  readonly schemaIdentity: string

  constructor(
    private readonly database: Database,
    private readonly statements: string[],
  ) {
    this.schemaIdentity = database.schemaIdentity
  }

  connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.database.connection((connection) => callback(this.recordingConnection(connection)))
  }

  transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction((connection) => callback(this.recordingConnection(connection)))
  }

  transactionActive(): boolean {
    return this.database.transactionActive?.() ?? false
  }

  close(): Promise<void> {
    return this.database.close()
  }

  private recordingConnection(connection: DatabaseConnection): DatabaseConnection {
    return {
      run: (sql, parameters) => connection.run(sql, parameters),
      get: <Row extends object>(sql: string, parameters?: QueryParameters) => {
        this.statements.push(sql.replace(/\s+/g, " ").trim())
        return connection.get<Row>(sql.replace(/\s+FOR UPDATE SKIP LOCKED\s*$/i, ""), parameters)
      },
      all: <Row extends object>(sql: string, parameters?: QueryParameters) =>
        connection.all<Row>(sql, parameters),
      nowMilliseconds: () => connection.nowMilliseconds(),
    }
  }
}

function configuredRuntime(database: Database): SolidObjectsRuntime {
  return configure({
    database,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
  })
}

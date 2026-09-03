import { afterEach, describe, expect, it } from "vitest"
import type { Database, DatabaseConnection } from "../src/database/types.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("polling queries", () => {
  it("locks one candidate per indexed query without combining recovery paths", async () => {
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
    expect(pollingStatements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /WHERE effects\.status = 'pending'.*ORDER BY effects\.available_at_ms, effects\.id LIMIT 1 FOR UPDATE SKIP LOCKED$/,
        ),
        expect.stringMatching(
          /WHERE reminders\.status = 'scheduled'.*reminders\.claimed_by IS NULL.*ORDER BY reminders\.run_at_ms, reminders\.id LIMIT 1 FOR UPDATE SKIP LOCKED$/,
        ),
        expect.stringMatching(
          /WHERE reminders\.status = 'scheduled'.*reminders\.claimed_by IS NOT NULL.*ORDER BY reminders\.run_at_ms, reminders\.id LIMIT 1 FOR UPDATE SKIP LOCKED$/,
        ),
        expect.stringMatching(
          /WHERE broadcasts\.status = 'pending'.*ORDER BY broadcasts\.available_at_ms, broadcasts\.id LIMIT 1 FOR UPDATE SKIP LOCKED$/,
        ),
        expect.stringMatching(
          /WHERE broadcasts\.status = 'processing'.*ORDER BY broadcasts\.available_at_ms, broadcasts\.id LIMIT 1 FOR UPDATE SKIP LOCKED$/,
        ),
      ]),
    )
    const pendingBroadcast = pollingStatements.find((statement) =>
      statement.includes("broadcasts.status = 'pending'"),
    )
    expect(pendingBroadcast).not.toMatch(/broadcasts\.status = 'processing'/)
    const availableReminder = pollingStatements.find((statement) =>
      statement.includes("reminders.claimed_by IS NULL"),
    )
    expect(availableReminder).not.toMatch(/reminders\.claimed_by IS NOT NULL/)
  })
})

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
      get: <Row extends object>(sql: string, parameters?: readonly unknown[]) => {
        this.statements.push(sql.replace(/\s+/g, " ").trim())
        return connection.get<Row>(sql.replace(/\s+FOR UPDATE SKIP LOCKED\s*$/i, ""), parameters)
      },
      all: <Row extends object>(sql: string, parameters?: readonly unknown[]) =>
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

import { DatabaseSync } from "node:sqlite"
import type { Database, DatabaseConnection, RunResult } from "./types.js"

export interface SQLiteDatabaseOptions {
  path: string
  timeoutMilliseconds?: number
}

class SQLiteConnection implements DatabaseConnection {
  constructor(private readonly database: DatabaseSync) {}

  async run(sql: string, parameters: readonly unknown[] = []): Promise<RunResult> {
    const result = this.database.prepare(sql).run(...parameters.map(normalizeParameter))
    const output: RunResult = { changes: Number(result.changes) }
    if (result.lastInsertRowid !== 0) output.lastInsertId = String(result.lastInsertRowid)
    return output
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row | undefined> {
    return this.database.prepare(sql).get(...parameters.map(normalizeParameter)) as Row | undefined
  }

  async all<Row extends object>(sql: string, parameters: readonly unknown[] = []): Promise<Row[]> {
    return this.database.prepare(sql).all(...parameters.map(normalizeParameter)) as Row[]
  }

  async nowMilliseconds(): Promise<number> {
    const row = this.database
      .prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms")
      .get() as { now_ms: number | bigint }
    return Number(row.now_ms)
  }
}

export class SQLiteDatabase implements Database {
  readonly family = "sqlite" as const
  readonly schemaIdentity = "solid-objects-node-v1"
  private readonly database: DatabaseSync
  private readonly databaseConnection: SQLiteConnection
  private accessTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: SQLiteDatabaseOptions) {
    this.database = new DatabaseSync(options.path, {
      timeout: options.timeoutMilliseconds ?? 5_000,
      readBigInts: true,
    })
    this.database.exec("PRAGMA foreign_keys = ON")
    this.databaseConnection = new SQLiteConnection(this.database)
  }

  async connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.withAccess(() => callback(this.databaseConnection))
  }

  async transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.withAccess(async () => {
      this.database.exec("BEGIN IMMEDIATE")
      try {
        const result = await callback(this.databaseConnection)
        this.database.exec("COMMIT")
        return result
      } catch (error) {
        this.database.exec("ROLLBACK")
        throw error
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.accessTail
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  private async withAccess<Result>(callback: () => Promise<Result>): Promise<Result> {
    const previous = this.accessTail
    let release = () => {}
    this.accessTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await callback()
    } finally {
      release()
    }
  }
}

export function sqlite(options: SQLiteDatabaseOptions): SQLiteDatabase {
  return new SQLiteDatabase(options)
}

function normalizeParameter(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined) return null
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  )
    return value

  if (typeof value === "boolean") return value ? 1 : 0
  throw new TypeError(`unsupported SQLite parameter ${typeof value}`)
}

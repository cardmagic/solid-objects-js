import { DatabaseSync } from "node:sqlite"
import type { Database, DatabaseConnection, RunResult } from "./types.js"
import { databaseDeadlineError, requireDatabaseDeadlineRemaining } from "./deadline.js"
import { DatabaseDeadlineExceeded } from "../errors.js"

export interface SQLiteDatabaseOptions {
  path: string
  timeoutMilliseconds?: number
}

class SQLiteConnection implements DatabaseConnection {
  constructor(private readonly database: DatabaseSync) {}

  async run(sql: string, parameters: readonly unknown[] = []): Promise<RunResult> {
    requireDatabaseDeadlineRemaining()
    const result = this.database.prepare(sql).run(...parameters.map(normalizeParameter))
    const output: RunResult = { changes: Number(result.changes) }
    if (result.lastInsertRowid !== 0) output.lastInsertId = String(result.lastInsertRowid)
    return output
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row | undefined> {
    requireDatabaseDeadlineRemaining()
    return this.database.prepare(sql).get(...parameters.map(normalizeParameter)) as Row | undefined
  }

  async all<Row extends object>(sql: string, parameters: readonly unknown[] = []): Promise<Row[]> {
    requireDatabaseDeadlineRemaining()
    return this.database.prepare(sql).all(...parameters.map(normalizeParameter)) as Row[]
  }

  async nowMilliseconds(): Promise<number> {
    requireDatabaseDeadlineRemaining()
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
  private readonly timeoutMilliseconds: number

  constructor(options: SQLiteDatabaseOptions) {
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000
    this.database = new DatabaseSync(options.path, {
      timeout: this.timeoutMilliseconds,
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
    const initialRemaining = requireDatabaseDeadlineRemaining()
    const previous = this.accessTail
    let release = () => {}
    this.accessTail = new Promise<void>((resolve) => {
      release = resolve
    })
    if (initialRemaining !== undefined) {
      try {
        await waitForAccess(previous, initialRemaining)
      } catch (error) {
        void previous.then(release, release)
        throw error
      }
    } else {
      await previous
    }
    try {
      if (initialRemaining !== undefined) requireDatabaseDeadlineRemaining()
      return await this.withBusyTimeout(callback)
    } finally {
      release()
    }
  }

  private async withBusyTimeout<Result>(callback: () => Promise<Result>): Promise<Result> {
    const remaining = requireDatabaseDeadlineRemaining()
    if (remaining === undefined) return callback()
    this.database.exec(`PRAGMA busy_timeout = ${Math.max(remaining, 1)}`)
    try {
      return await callback()
    } catch (error) {
      if (!sqliteBusyError(error)) throw error
      throw databaseDeadlineError(error)
    } finally {
      this.database.exec(`PRAGMA busy_timeout = ${this.timeoutMilliseconds}`)
    }
  }
}

function waitForAccess(access: Promise<void>, timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new DatabaseDeadlineExceeded("database deadline exceeded")),
      timeoutMilliseconds,
    )
    void access.then(
      () => {
        clearTimeout(timeout)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
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

function sqliteBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ERR_SQLITE_ERROR" || error.code === "SQLITE_BUSY") &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("database is locked")
  )
}

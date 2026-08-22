import sqlite3InitModule, {
  type BindableValue,
  type Database as WasmDatabaseHandle,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm"
import type { Database, DatabaseConnection, RunResult } from "./types.js"
import { requireDatabaseDeadlineRemaining } from "./deadline.js"
import { DatabaseDeadlineExceeded } from "../errors.js"
import { databaseTransactionActive, withDatabaseTransaction } from "./transaction-context.js"

export interface SQLiteWasmDatabaseOptions {
  path: string
  storage?: "temporary" | "persistent"
}

interface SQLiteWasmHandles {
  handle: WasmDatabaseHandle
  sqlite3: Sqlite3Static
}

class SQLiteWasmConnection implements DatabaseConnection {
  constructor(private readonly handles: SQLiteWasmHandles) {}

  async run(sql: string, parameters: readonly unknown[] = []): Promise<RunResult> {
    requireDatabaseDeadlineRemaining()
    this.execute({ sql, parameters })
    const output: RunResult = { changes: this.handles.handle.changes() }
    const lastInsertRowid = this.handles.sqlite3.capi.sqlite3_last_insert_rowid(this.handles.handle)
    if (Number(lastInsertRowid) !== 0) output.lastInsertId = String(lastInsertRowid)
    return output
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row | undefined> {
    const rows = await this.all<Row>(sql, parameters)
    return rows[0]
  }

  async all<Row extends object>(sql: string, parameters: readonly unknown[] = []): Promise<Row[]> {
    requireDatabaseDeadlineRemaining()
    const resultRows: Row[] = []
    this.execute({ sql, parameters, resultRows })
    return resultRows
  }

  async nowMilliseconds(): Promise<number> {
    const row = await this.get<{ now_ms: number | bigint }>(
      "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms",
    )
    if (row === undefined) throw new Error("SQLite returned no clock row")
    return Number(row.now_ms)
  }

  private execute(options: {
    sql: string
    parameters: readonly unknown[]
    resultRows?: object[]
  }): void {
    const bind = options.parameters.map(normalizeParameter)
    this.handles.handle.exec({
      sql: options.sql,
      rowMode: "object",
      ...(bind.length > 0 ? { bind } : {}),
      ...(options.resultRows ? { resultRows: options.resultRows as never } : {}),
    })
  }
}

export class SQLiteWasmDatabase implements Database {
  readonly family = "sqlite" as const
  readonly schemaIdentity = "solid-objects-wasm-v1"
  private readonly handles: SQLiteWasmHandles
  private readonly databaseConnection: SQLiteWasmConnection
  private accessTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(handles: SQLiteWasmHandles) {
    this.handles = handles
    this.handles.handle.exec("PRAGMA foreign_keys = ON")
    this.databaseConnection = new SQLiteWasmConnection(handles)
  }

  async connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.withAccess(() => callback(this.databaseConnection))
  }

  async transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return withDatabaseTransaction(this, () => this.withAccess(() => this.runTransaction(callback)))
  }

  transactionActive(): boolean {
    return databaseTransactionActive(this)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.accessTail
    if (this.closed) return
    this.handles.handle.close()
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
      if (this.closed) throw new Error("SQLite WASM database is closed")
      return await callback()
    } finally {
      release()
    }
  }

  private async runTransaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    this.handles.handle.exec("BEGIN IMMEDIATE")
    try {
      const result = await callback(this.databaseConnection)
      this.handles.handle.exec("COMMIT")
      return result
    } catch (error) {
      this.handles.handle.exec("ROLLBACK")
      throw error
    }
  }
}

let sqlite3ModulePromise: Promise<Sqlite3Static> | undefined

function loadSqlite3(): Promise<Sqlite3Static> {
  sqlite3ModulePromise ??= sqlite3InitModule()
  return sqlite3ModulePromise
}

export async function sqliteWasm(options: SQLiteWasmDatabaseOptions): Promise<SQLiteWasmDatabase> {
  const sqlite3 = await loadSqlite3()
  const handle = await openHandle({ sqlite3, options })
  return new SQLiteWasmDatabase({ handle, sqlite3 })
}

async function openHandle(context: {
  sqlite3: Sqlite3Static
  options: SQLiteWasmDatabaseOptions
}): Promise<WasmDatabaseHandle> {
  if (context.options.storage !== "persistent") {
    return new context.sqlite3.oo1.DB(context.options.path, "c")
  }
  const pool = await context.sqlite3.installOpfsSAHPoolVfs({})
  return new pool.OpfsSAHPoolDb(context.options.path)
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

function normalizeParameter(value: unknown): BindableValue {
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

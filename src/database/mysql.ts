import mysqlDriver, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise"
import type { ExecuteValues } from "mysql2"
import type { Database, DatabaseConnection, RunResult } from "./types.js"
import {
  acquireBeforeDatabaseDeadline,
  databaseDeadlineRemainingMilliseconds,
  databaseDeadlineError,
  requireDatabaseDeadlineRemaining,
} from "./deadline.js"
import { DatabaseDeadlineExceeded } from "../errors.js"
import { databaseTransactionActive, withDatabaseTransaction } from "./transaction-context.js"

export interface MySQLDatabaseOptions {
  connectionString: string
  maximumConnections?: number
  idleTimeoutMilliseconds?: number
  queueLimit?: number
}

class MySQLConnection implements DatabaseConnection {
  constructor(private readonly connection: PoolConnection) {}

  async run(sql: string, parameters: readonly unknown[] = []): Promise<RunResult> {
    const remaining = requireDatabaseDeadlineRemaining()
    const query = mysqlSql(sql)
    const values = mysqlParameters(parameters)
    const [result] =
      remaining === undefined
        ? await this.connection.query<ResultSetHeader>(query, values)
        : await this.connection.query<ResultSetHeader>(
            { sql: query, timeout: Math.max(remaining, 1) },
            values,
          )
    return {
      changes: result.affectedRows,
      ...(result.insertId === 0 ? {} : { lastInsertId: String(result.insertId) }),
    }
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row | undefined> {
    const remaining = requireDatabaseDeadlineRemaining()
    const query = mysqlSql(sql)
    const values = mysqlParameters(parameters)
    const [rows] =
      remaining === undefined
        ? await this.connection.query<RowDataPacket[]>(query, values)
        : await this.connection.query<RowDataPacket[]>(
            { sql: query, timeout: Math.max(remaining, 1) },
            values,
          )
    return rows[0] as Row | undefined
  }

  async all<Row extends object>(sql: string, parameters: readonly unknown[] = []): Promise<Row[]> {
    const remaining = requireDatabaseDeadlineRemaining()
    const query = mysqlSql(sql)
    const values = mysqlParameters(parameters)
    const [rows] =
      remaining === undefined
        ? await this.connection.query<RowDataPacket[]>(query, values)
        : await this.connection.query<RowDataPacket[]>(
            { sql: query, timeout: Math.max(remaining, 1) },
            values,
          )
    return rows as Row[]
  }

  async nowMilliseconds(): Promise<number> {
    const remaining = requireDatabaseDeadlineRemaining()
    const query = "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms"
    const [rows] =
      remaining === undefined
        ? await this.connection.query<RowDataPacket[]>(query)
        : await this.connection.query<RowDataPacket[]>({
            sql: query,
            timeout: Math.max(remaining, 1),
          })
    const row = rows[0] as { now_ms?: number | string } | undefined
    if (row?.now_ms === undefined) throw new Error("MySQL did not return database time")
    return Number(row.now_ms)
  }
}

export class MySQLDatabase implements Database {
  readonly family = "mysql" as const
  readonly schemaIdentity = "solid-objects-node-v1"
  private readonly pool: Pool
  private closed = false

  constructor(options: MySQLDatabaseOptions) {
    if (options.connectionString.length === 0) {
      throw new TypeError("MySQL connectionString must not be empty")
    }
    if (
      options.maximumConnections !== undefined &&
      (!Number.isSafeInteger(options.maximumConnections) || options.maximumConnections < 1)
    ) {
      throw new TypeError("MySQL maximumConnections must be a positive safe integer")
    }
    for (const [name, value] of [
      ["idleTimeoutMilliseconds", options.idleTimeoutMilliseconds],
      ["queueLimit", options.queueLimit],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError(`MySQL ${name} must be a non-negative safe integer`)
      }
    }
    this.pool = mysqlDriver.createPool({
      uri: options.connectionString,
      connectionLimit: options.maximumConnections ?? 10,
      idleTimeout: options.idleTimeoutMilliseconds ?? 60_000,
      queueLimit: options.queueLimit ?? 0,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: "utf8mb4",
    })
  }

  async connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    const deadlineActive = databaseDeadlineRemainingMilliseconds() !== undefined
    const connection = await acquireBeforeDatabaseDeadline(
      this.pool.getConnection(),
      (lateConnection) => lateConnection.release(),
    )
    let discardConnection = false
    try {
      const result = await callback(new MySQLConnection(connection))
      requireDatabaseDeadlineRemaining()
      return result
    } catch (error) {
      if (deadlineActive && mysqlDeadlineError(error)) {
        discardConnection = true
        throw databaseDeadlineError(error)
      }
      throw error
    } finally {
      if (discardConnection) connection.destroy()
      else connection.release()
    }
  }

  async transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return withDatabaseTransaction(this, async () => {
      const deadlineActive = databaseDeadlineRemainingMilliseconds() !== undefined
      const connection = await acquireBeforeDatabaseDeadline(
        this.pool.getConnection(),
        (lateConnection) => lateConnection.release(),
      )
      try {
        await connection.beginTransaction()
        const remaining = requireDatabaseDeadlineRemaining()
        if (remaining !== undefined) {
          await connection.query("SET SESSION innodb_lock_wait_timeout = ?", [
            Math.max(Math.ceil(remaining / 1_000), 1),
          ])
          await connection.query("SET SESSION max_execution_time = ?", [Math.max(remaining, 1)])
        }
        const result = await callback(new MySQLConnection(connection))
        requireDatabaseDeadlineRemaining()
        await connection.commit()
        return result
      } catch (error) {
        await connection.rollback().catch(() => undefined)
        if (
          error instanceof DatabaseDeadlineExceeded ||
          (deadlineActive && mysqlDeadlineError(error))
        ) {
          throw databaseDeadlineError(error)
        }
        throw error
      } finally {
        if (deadlineActive) {
          await connection
            .query("SET SESSION innodb_lock_wait_timeout = DEFAULT")
            .catch(() => undefined)
          await connection.query("SET SESSION max_execution_time = DEFAULT").catch(() => undefined)
        }
        connection.release()
      }
    })
  }

  transactionActive(): boolean {
    return databaseTransactionActive(this)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }
}

function mysqlDeadlineError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error &&
      (error.code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
        error.code === "ER_LOCK_WAIT_TIMEOUT" ||
        error.code === "ER_QUERY_TIMEOUT")) ||
      ("message" in error &&
        typeof error.message === "string" &&
        error.message.includes("operation timeout")))
  )
}

export function mysql(options: MySQLDatabaseOptions): MySQLDatabase {
  return new MySQLDatabase(options)
}

export function mysqlSql(sql: string): string {
  const conflict = /\s+ON CONFLICT\s*\([^)]+\)\s+DO NOTHING\s*$/i
  if (conflict.test(sql))
    return sql.replace(/^\s*INSERT\s+INTO/i, "INSERT IGNORE INTO").replace(conflict, "")
  return sql
    .replace(/\s+ON CONFLICT\s*\([^)]+\)\s+DO UPDATE SET\s+/i, " ON DUPLICATE KEY UPDATE ")
    .replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)\b/gi, "VALUES($1)")
}

function mysqlParameters(parameters: readonly unknown[]): ExecuteValues[] {
  return parameters.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean" ||
      value instanceof Date ||
      value instanceof Uint8Array
    ) {
      return value
    }
    throw new TypeError("MySQL parameters must be scalar database values")
  })
}

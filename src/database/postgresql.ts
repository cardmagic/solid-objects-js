import "../platform/node-context-store.js"
import { Pool, TypeOverrides, types, type PoolClient, type PoolConfig } from "pg"
import { postgresqlSql } from "./postgresql-sql.js"
import type { Database, DatabaseConnection, RunResult } from "./types.js"
import { PostgreSQLWakeUpAdapter, type PostgreSQLWakeUpFailure } from "../wake-up/postgresql.js"
import {
  acquireBeforeDatabaseDeadline,
  databaseDeadlineRemainingMilliseconds,
  databaseDeadlineError,
  requireDatabaseDeadlineRemaining,
} from "./deadline.js"
import { DatabaseDeadlineExceeded } from "../errors.js"
import { databaseTransactionActive, withDatabaseTransaction } from "./transaction-context.js"

export {
  PostgreSQLWakeUpAdapter,
  postgresqlWakeUp,
  type PostgreSQLWakeUpFailure,
  type PostgreSQLWakeUpOptions,
} from "../wake-up/postgresql.js"

export interface PostgreSQLDatabaseOptions {
  connectionString: string
  maximumConnections?: number
  idleTimeoutMilliseconds?: number
  connectionTimeoutMilliseconds?: number
  applicationName?: string
  onPoolError?: (error: Error) => void
}

export interface PostgreSQLDatabaseWakeUpOptions {
  channelPrefix?: string
  applicationName?: string
  onListenerError?: (failure: PostgreSQLWakeUpFailure) => void
}

class PostgreSQLConnection implements DatabaseConnection {
  constructor(private readonly client: PoolClient) {}

  async run(sql: string, parameters: readonly unknown[] = []): Promise<RunResult> {
    requireDatabaseDeadlineRemaining()
    const result = await this.client.query(postgresqlSql(sql), [...parameters])
    return { changes: result.rowCount ?? 0 }
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row | undefined> {
    requireDatabaseDeadlineRemaining()
    const result = await this.client.query<Row>(postgresqlSql(sql), [...parameters])
    return result.rows[0]
  }

  async all<Row extends object>(sql: string, parameters: readonly unknown[] = []): Promise<Row[]> {
    requireDatabaseDeadlineRemaining()
    const result = await this.client.query<Row>(postgresqlSql(sql), [...parameters])
    return result.rows
  }

  async nowMilliseconds(): Promise<number> {
    requireDatabaseDeadlineRemaining()
    const result = await this.client.query<{ now_ms: string }>(
      "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now_ms",
    )
    const row = result.rows[0]
    if (!row) throw new Error("PostgreSQL did not return database time")
    return Number(row.now_ms)
  }
}

export class PostgreSQLDatabase implements Database {
  readonly family = "postgresql" as const
  readonly schemaIdentity = "solid-objects-node-v1"
  private readonly pool: Pool
  private readonly connectionString: string
  private closed = false

  constructor(options: PostgreSQLDatabaseOptions) {
    if (options.connectionString.length === 0) {
      throw new TypeError("PostgreSQL connectionString must not be empty")
    }
    this.connectionString = options.connectionString
    if (
      options.maximumConnections !== undefined &&
      (!Number.isSafeInteger(options.maximumConnections) || options.maximumConnections < 1)
    ) {
      throw new TypeError("PostgreSQL maximumConnections must be a positive safe integer")
    }
    for (const [name, value] of [
      ["idleTimeoutMilliseconds", options.idleTimeoutMilliseconds],
      ["connectionTimeoutMilliseconds", options.connectionTimeoutMilliseconds],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new TypeError(`PostgreSQL ${name} must be a non-negative number`)
      }
    }
    const configuration: PoolConfig = {
      connectionString: options.connectionString,
      types: postgresqlTypes(),
      ...(options.maximumConnections === undefined ? {} : { max: options.maximumConnections }),
      ...(options.idleTimeoutMilliseconds === undefined
        ? {}
        : { idleTimeoutMillis: options.idleTimeoutMilliseconds }),
      ...(options.connectionTimeoutMilliseconds === undefined
        ? {}
        : { connectionTimeoutMillis: options.connectionTimeoutMilliseconds }),
      ...(options.applicationName === undefined
        ? { application_name: "solid-objects" }
        : { application_name: options.applicationName }),
    }
    this.pool = new Pool(configuration)
    this.pool.on(
      "error",
      options.onPoolError ??
        ((error) =>
          console.error({
            event: "solid_objects.postgresql.pool_error",
            errorName: error.name,
          })),
    )
  }

  async connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    const deadlineActive = databaseDeadlineRemainingMilliseconds() !== undefined
    const client = await acquireBeforeDatabaseDeadline(
      () => this.pool.connect(),
      (lateClient) => lateClient.release(),
    )
    let discardConnection = false
    try {
      const remaining = requireDatabaseDeadlineRemaining()
      if (remaining !== undefined) {
        await applyPostgreSQLDeadline({ client, milliseconds: remaining })
      }
      const result = await callback(new PostgreSQLConnection(client))
      requireDatabaseDeadlineRemaining()
      return result
    } catch (error) {
      if (deadlineActive && postgresqlDeadlineError(error)) {
        discardConnection = true
        throw databaseDeadlineError(error)
      }
      throw error
    } finally {
      if (deadlineActive && !discardConnection) {
        await client.query("RESET statement_timeout; RESET lock_timeout").catch(() => undefined)
      }
      client.release(discardConnection)
    }
  }

  async transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return withDatabaseTransaction(this, async () => {
      const deadlineActive = databaseDeadlineRemainingMilliseconds() !== undefined
      const client = await acquireBeforeDatabaseDeadline(
        () => this.pool.connect(),
        (lateClient) => lateClient.release(),
      )
      try {
        await client.query("BEGIN")
        const remaining = requireDatabaseDeadlineRemaining()
        if (remaining !== undefined) {
          await applyPostgreSQLDeadline({ client, milliseconds: remaining, scope: "transaction" })
        }
        const result = await callback(new PostgreSQLConnection(client))
        requireDatabaseDeadlineRemaining()
        await client.query("COMMIT")
        return result
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        if (
          error instanceof DatabaseDeadlineExceeded ||
          (deadlineActive && postgresqlDeadlineError(error))
        ) {
          throw databaseDeadlineError(error)
        }
        throw error
      } finally {
        client.release()
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

  wakeUp(options: PostgreSQLDatabaseWakeUpOptions = {}): PostgreSQLWakeUpAdapter {
    return new PostgreSQLWakeUpAdapter({
      connectionString: this.connectionString,
      ...options,
    })
  }
}

async function applyPostgreSQLDeadline(options: {
  client: PoolClient
  milliseconds: number
  scope?: "session" | "transaction"
}): Promise<void> {
  const scope = options.scope === "transaction" ? "LOCAL " : ""
  const timeout = Math.max(options.milliseconds, 1)
  await options.client.query(`SET ${scope}statement_timeout = ${timeout}`)
  await options.client.query(`SET ${scope}lock_timeout = ${timeout}`)
}

function postgresqlDeadlineError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "57014" || error.code === "55P03")
  )
}

function postgresqlTypes(): TypeOverrides {
  const overrides = new TypeOverrides()
  overrides.setTypeParser(types.builtins.INT8, (value) => BigInt(value))
  return overrides
}

export function postgresql(options: PostgreSQLDatabaseOptions): PostgreSQLDatabase {
  return new PostgreSQLDatabase(options)
}

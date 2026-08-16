import { Actor, createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { mysql } from "solid-objects/database/mysql"
import { postgresql } from "solid-objects/database/postgresql"
import { sqlite } from "solid-objects/database/sqlite"

export type BenchmarkDatabase = "sqlite" | "postgresql" | "mysql"

export class BenchmarkCounter extends Actor {
  static override readonly actorType = "BenchmarkCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }

  async incrementAfterYield(): Promise<number> {
    await new Promise((resolve) => setImmediate(resolve))
    this.count += 1
    return this.count
  }
}

export function benchmarkRuntime(options: {
  database: BenchmarkDatabase
  databasePath?: string
  databaseUrl?: string
  tableNamePrefix: string
  workerCount: number
}): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: benchmarkDatabase(options),
    tableNamePrefix: options.tableNamePrefix,
    pollingIntervalMilliseconds: 5,
    workerCount: options.workerCount,
    effectWorkerCount: 0,
    reminderSchedulerCount: 0,
    retentionIntervalMilliseconds: 0,
    deadProcessCleanupIntervalMilliseconds: 0,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
  })
  runtime.register(BenchmarkCounter)
  return runtime
}

function benchmarkDatabase(options: {
  database: BenchmarkDatabase
  databasePath?: string
  databaseUrl?: string
}) {
  if (options.database === "sqlite") {
    if (!options.databasePath) throw new TypeError("databasePath is required for SQLite")
    return sqlite({
      path: options.databasePath,
      timeoutMilliseconds: 10_000,
      lockRetryAttempts: 50,
    })
  }
  if (!options.databaseUrl) throw new TypeError("databaseUrl is required")
  if (options.database === "postgresql") {
    return postgresql({ connectionString: options.databaseUrl, maximumConnections: 20 })
  }
  return mysql({ connectionString: options.databaseUrl, maximumConnections: 20 })
}

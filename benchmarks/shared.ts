import { Actor, createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { mysql } from "solid-objects/database/mysql"
import { postgresql } from "solid-objects/database/postgresql"
import { sqlite } from "solid-objects/database/sqlite"

export type BenchmarkDatabase = "sqlite" | "postgresql" | "mysql"
export type BenchmarkWorkload = "counter" | "cart-outbox"

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

export class BenchmarkCart extends Actor {
  static override readonly actorType = "BenchmarkCart"
  count = 0
  totalCents = 0
  lines = Array.from({ length: 20 }, (_value, index) => ({
    sku: `sku-${index}`,
    quantity: 1,
    priceCents: 100 + index,
  }))

  increment(): number {
    const line = this.lines[this.count % this.lines.length]!
    line.quantity += 1
    this.count += 1
    this.totalCents = this.lines.reduce((sum, item) => sum + item.quantity * item.priceCents, 0)
    this.emit("cartChanged", { arguments: { totalCents: this.totalCents } })
    return this.count
  }

  async incrementAfterYield(): Promise<number> {
    await new Promise((resolve) => setImmediate(resolve))
    return this.increment()
  }
}

export class LargeStateCounter extends Actor {
  static override readonly actorType = "LargeStateCounter"

  count = 0
  payload = ""

  resize({ size }: { size: number }): number {
    this.payload = "s".repeat(size)
    return this.payload.length
  }

  increment(): number {
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
  runtime.register(BenchmarkCart)
  runtime.register(LargeStateCounter)
  runtime.registerEffect("cartChanged", async () => null)
  return runtime
}

function benchmarkDatabase(options: {
  database: BenchmarkDatabase
  databasePath?: string
  databaseUrl?: string
}) {
  if (options.database === "sqlite") {
    if (!options.databasePath) throw new TypeError("databasePath is required for SQLite")
    const synchronous = process.env.SOLID_OBJECTS_BENCHMARK_SQLITE_SYNCHRONOUS || undefined
    if (synchronous !== undefined && synchronous !== "normal" && synchronous !== "full") {
      throw new TypeError("benchmark SQLite synchronous must be normal or full")
    }
    return sqlite({
      path: options.databasePath,
      timeoutMilliseconds: 10_000,
      lockRetryAttempts: 50,
      ...(synchronous ? { synchronous } : {}),
    })
  }
  if (!options.databaseUrl) throw new TypeError("databaseUrl is required")
  if (options.database === "postgresql") {
    return postgresql({ connectionString: options.databaseUrl, maximumConnections: 20 })
  }
  return mysql({ connectionString: options.databaseUrl, maximumConnections: 20 })
}

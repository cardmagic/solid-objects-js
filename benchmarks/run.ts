import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { fork, type ChildProcess } from "node:child_process"
import { performance } from "node:perf_hooks"
import type { MessageReference } from "solid-objects"
import { waitForWorkerExit, waitForWorkerReady } from "./processes.ts"
import { BenchmarkCounter, benchmarkRuntime, type BenchmarkDatabase } from "./shared.ts"

type Shape = "warm-hot" | "warm-many" | "cold-many"
type Handler = "synchronous" | "asynchronous"
type Topology = "one-process" | "four-processes"

interface Result {
  shape: Shape
  handler: Handler
  topology: Topology
  operations: number
  concurrency: number
  throughputPerSecond: number
  latencyMilliseconds: { p50: number; p95: number; p99: number }
}

const database = option("database", "sqlite") as BenchmarkDatabase
if (!(["sqlite", "postgresql", "mysql"] as const).includes(database)) {
  throw new TypeError(`unsupported database ${database}`)
}
const operations = positiveIntegerOption("operations", 250)
const warmupOperations = positiveIntegerOption("warmup", 25)
const concurrency = positiveIntegerOption("concurrency", 16)
const temporaryDirectory = await mkdtemp(join(tmpdir(), "solid-objects-benchmark-"))
const databasePath = join(temporaryDirectory, "benchmark.sqlite3")
const databaseLocation =
  database === "postgresql"
    ? requiredEnvironment("SOLID_OBJECTS_POSTGRESQL_BENCHMARK_URL")
    : database === "mysql"
      ? requiredEnvironment("SOLID_OBJECTS_MYSQL_BENCHMARK_URL")
      : databasePath
const tableNamePrefix = `solid_objects_benchmark_${process.pid}_`
const results: Result[] = []

try {
  for (const topology of ["one-process", "four-processes"] as const) {
    const runtime = benchmarkRuntime({
      database,
      ...(database === "sqlite"
        ? { databasePath: databaseLocation }
        : { databaseUrl: databaseLocation }),
      tableNamePrefix,
      workerCount: topology === "one-process" ? 4 : 1,
    })
    const shutdown = new AbortController()
    let running: Promise<void> | undefined
    let workers: ChildProcess[] = []
    try {
      await runtime.install()
      if (topology === "one-process") {
        running = runtime.run(shutdown.signal)
      } else {
        workers = await spawnWorkers({
          database,
          location: databaseLocation,
          tableNamePrefix,
        })
      }
      for (const shape of ["warm-hot", "warm-many", "cold-many"] as const) {
        for (const handler of ["synchronous", "asynchronous"] as const) {
          results.push(
            await measure({
              runtime,
              shape,
              handler,
              topology,
              operations,
              warmupOperations,
              concurrency,
            }),
          )
        }
      }
    } finally {
      shutdown.abort()
      await running
      const workerExits = workers.map(waitForWorkerExit)
      for (const worker of workers) worker.send("stop")
      await Promise.all(workerExits)
      await runtime.testing.reset()
      await runtime.close()
    }
  }

  const runtime = benchmarkRuntime({
    database,
    ...(database === "sqlite"
      ? { databasePath: databaseLocation }
      : { databaseUrl: databaseLocation }),
    tableNamePrefix,
    workerCount: 1,
  })
  await runtime.install()
  const databaseVersion = await readDatabaseVersion(runtime)
  await runtime.close()
  process.stdout.write(
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        packageVersion: "0.13.0",
        runtime: {
          node: process.version,
          platform: `${platform()} ${release()}`,
          cpu: cpus()[0]?.model ?? "unknown",
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
          freeMemoryBytesAtReport: freemem(),
        },
        database: { adapter: database, version: databaseVersion },
        methodology: {
          operations,
          warmupOperations,
          concurrency,
          warmIdentityCount: 100,
          workerCount: 4,
          latencyBoundary: "durable enqueue through committed result",
          percentile: "nearest rank",
        },
        results,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await rm(temporaryDirectory, { recursive: true })
}

async function measure(options: {
  runtime: ReturnType<typeof benchmarkRuntime>
  shape: Shape
  handler: Handler
  topology: Topology
  operations: number
  warmupOperations: number
  concurrency: number
}): Promise<Result> {
  const runId = `${options.topology}-${options.shape}-${options.handler}-${Date.now()}`
  const actorIds = Array.from({ length: 100 }, (_value, index) => `${runId}-warm-${index}`)
  if (options.shape !== "cold-many") {
    const ids = options.shape === "warm-hot" ? [actorIds[0] as string] : actorIds
    await runBatch({ ...options, operations: ids.length, actorId: (index) => ids[index] as string })
  }
  await runBatch({
    ...options,
    operations: options.warmupOperations,
    actorId: identitySelector(options.shape, actorIds, `${runId}-warmup`),
  })
  const startedAt = performance.now()
  const latencies = await runBatch({
    ...options,
    actorId: identitySelector(options.shape, actorIds, `${runId}-measure`),
  })
  const elapsedMilliseconds = performance.now() - startedAt
  return {
    shape: options.shape,
    handler: options.handler,
    topology: options.topology,
    operations: options.operations,
    concurrency: options.concurrency,
    throughputPerSecond: round((options.operations * 1_000) / elapsedMilliseconds),
    latencyMilliseconds: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
  }
}

async function runBatch(options: {
  runtime: ReturnType<typeof benchmarkRuntime>
  handler: Handler
  operations: number
  concurrency: number
  actorId(index: number): string
}): Promise<number[]> {
  let nextIndex = 0
  const latencies: number[] = []
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.operations) }, async () => {
      for (;;) {
        const index = nextIndex
        nextIndex += 1
        if (index >= options.operations) return
        const reference = options.runtime.ref(BenchmarkCounter, options.actorId(index))
        const startedAt = performance.now()
        const message =
          options.handler === "synchronous"
            ? await reference.send.increment()
            : await reference.send.incrementAfterYield()
        await waitForResult(message)
        latencies.push(performance.now() - startedAt)
      }
    }),
  )
  assert.equal(latencies.length, options.operations)
  return latencies
}

async function waitForResult(message: MessageReference): Promise<void> {
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    if ((await message.result()) !== undefined) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  }
  throw new Error(`message ${message.id} did not complete within 60 seconds`)
}

function identitySelector(shape: Shape, warmIds: string[], prefix: string) {
  if (shape === "warm-hot") return () => warmIds[0] as string
  if (shape === "warm-many") return (index: number) => warmIds[index % warmIds.length] as string
  return (index: number) => `${prefix}-${index}`
}

async function spawnWorkers(options: {
  database: BenchmarkDatabase
  location: string
  tableNamePrefix: string
}): Promise<ChildProcess[]> {
  const workers = Array.from({ length: 4 }, () =>
    fork(
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
      [options.database, options.location, options.tableNamePrefix],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    ),
  )
  try {
    await Promise.all(workers.map(waitForWorkerReady))
    return workers
  } catch (error) {
    const workerExits = workers.map(waitForWorkerExit)
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill()
    }
    await Promise.allSettled(workerExits)
    throw error
  }
}

async function readDatabaseVersion(runtime: ReturnType<typeof benchmarkRuntime>): Promise<string> {
  return runtime.settings.database.connection(async (connection) => {
    if (database === "sqlite") {
      const row = await connection.get<{ version: string }>("SELECT sqlite_version() AS version")
      return row?.version ?? "unknown"
    }
    if (database === "postgresql") {
      const row = await connection.get<{ version: string }>(
        "SELECT current_setting('server_version') AS version",
      )
      return row?.version ?? "unknown"
    }
    const row = await connection.get<{ version: string }>("SELECT VERSION() AS version")
    return row?.version ?? "unknown"
  })
}

function percentile(values: number[], percent: number): number {
  const ordered = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil((percent / 100) * ordered.length) - 1)
  return round(ordered[index] ?? 0)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value) throw new TypeError(`--${name} requires a value`)
  return value
}

function positiveIntegerOption(name: string, fallback: number): number {
  const value = Number(option(name, String(fallback)))
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`--${name} must be a positive integer`)
  }
  return value
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import assert from "node:assert/strict"
import { benchmarkMetadata } from "./metadata.ts"
import type { MessageReference } from "solid-objects"
import { LargeStateCounter, benchmarkRuntime } from "./shared.ts"

const sizes = option("sizes", "0,16384,131072,1048576")
  .split(",")
  .map((value) => nonNegativeInteger(value, "sizes"))
const operations = positiveInteger(option("operations", "50"), "operations")
const warmupOperations = positiveInteger(option("warmup", "5"), "warmup")

const repetitions = positiveInteger(option("repetitions", "3"), "repetitions")

const temporaryDirectory = await mkdtemp(join(tmpdir(), "solid-objects-large-state-"))
const databasePath = join(temporaryDirectory, "large-state.sqlite3")
const tableNamePrefix = `solid_objects_large_state_${process.pid}_`

try {
  const results = []
  for (let sample = 1; sample <= repetitions; sample += 1) {
    for (const size of sizes) results.push({ sample, ...(await measure(size)) })
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ...(await benchmarkMetadata()),
        database: {
          adapter: "sqlite",
          storage: "temporary file",
          version: results[0]?.databaseVersion,
        },
        methodology: {
          sizes,
          operations,
          warmupOperations,
          repetitions,
          concurrency: 1,
          shape: "one actor, one increment operation, sequential turns",
          latencyBoundary: "durable enqueue through committed result",
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

async function measure(size: number) {
  const runtime = benchmarkRuntime({
    database: "sqlite",
    databasePath,
    tableNamePrefix: `${tableNamePrefix}${size}_`,
    workerCount: 1,
  })
  const shutdown = new AbortController()
  let running: Promise<void> | undefined
  try {
    await runtime.install()
    running = runtime.run(shutdown.signal)
    const reference = runtime.ref(LargeStateCounter, `large-state-${size}`)
    if (size > 0) await waitForResult(await reference.send.resize({ size }))
    for (let index = 0; index < warmupOperations; index += 1) {
      await waitForResult(await reference.send.increment())
    }

    const latenciesMilliseconds: number[] = []
    const startedAt = performance.now()
    for (let index = 0; index < operations; index += 1) {
      const operationStartedAt = performance.now()
      await waitForResult(await reference.send.increment())
      latenciesMilliseconds.push(round(performance.now() - operationStartedAt))
    }
    const elapsedMilliseconds = performance.now() - startedAt

    const snapshot = await reference.snapshot()
    assert.equal(snapshot.count, operations + warmupOperations)
    assert.equal(snapshot.payload.length, size)
    const databaseVersion = await runtime.settings.database.connection(
      async (connection) =>
        (await connection.get<{ version: string }>("SELECT sqlite_version() AS version"))?.version,
    )
    return {
      payloadBytes: size,
      stateBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      databaseVersion,
      latenciesMilliseconds,
      operations,
      millisecondsPerOperation: round(elapsedMilliseconds / operations),
      throughputPerSecond: round((operations * 1_000) / elapsedMilliseconds),
    }
  } finally {
    shutdown.abort()
    await running
    await runtime.testing.reset()
    await runtime.close()
  }
}

async function waitForResult(message: MessageReference): Promise<void> {
  const deadline = performance.now() + 120_000
  while (performance.now() < deadline) {
    if ((await message.result()) !== undefined) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`message ${message.id} did not complete within 120 seconds`)
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value) throw new TypeError(`--${name} requires a value`)
  return value
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return number
}

function nonNegativeInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return number
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

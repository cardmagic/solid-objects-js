import { readFile } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { cpus, platform, release, tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { MessageReference } from "solid-objects"
import { LargeStateCounter, benchmarkRuntime } from "./shared.ts"

const sizes = option("sizes", "0,16384,131072,1048576")
  .split(",")
  .map((value) => nonNegativeInteger(value, "sizes"))
const operations = positiveInteger(option("operations", "50"), "operations")
const warmupOperations = positiveInteger(option("warmup", "5"), "warmup")

const temporaryDirectory = await mkdtemp(join(tmpdir(), "solid-objects-large-state-"))
const databasePath = join(temporaryDirectory, "large-state.sqlite3")
const tableNamePrefix = `solid_objects_large_state_${process.pid}_`

try {
  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
  const results = []
  for (const size of sizes) results.push(await measure(size))

  process.stdout.write(
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        packageVersion: packageMetadata.version,
        runtime: {
          node: process.version,
          platform: `${platform()} ${release()}`,
          cpu: cpus()[0]?.model ?? "unknown",
          logicalCpus: cpus().length,
        },
        database: { adapter: "sqlite", path: databasePath },
        methodology: {
          sizes,
          operations,
          warmupOperations,
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

    const startedAt = performance.now()
    for (let index = 0; index < operations; index += 1) {
      await waitForResult(await reference.send.increment())
    }
    const elapsedMilliseconds = performance.now() - startedAt

    return {
      stateBytes: size,
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

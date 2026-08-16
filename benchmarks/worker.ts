import { benchmarkRuntime, type BenchmarkDatabase } from "./shared.ts"

const database = requiredArgument(2) as BenchmarkDatabase
const location = requiredArgument(3)
const tableNamePrefix = requiredArgument(4)
const runtime = benchmarkRuntime({
  database,
  ...(database === "sqlite" ? { databasePath: location } : { databaseUrl: location }),
  tableNamePrefix,
  workerCount: 1,
})
const shutdown = new AbortController()

process.on("message", (message) => {
  if (message === "stop") shutdown.abort()
})

await runtime.install()
process.send?.("ready")
await runtime.run(shutdown.signal)
await runtime.close()
process.disconnect?.()

function requiredArgument(index: number): string {
  const value = process.argv[index]
  if (!value) throw new TypeError(`argument ${index - 1} is required`)
  return value
}

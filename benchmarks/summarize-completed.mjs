import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { completedComparison } from "./comparison-scope.mjs"
import { controlledTable } from "./publication.mjs"

if (process.argv.length !== 3)
  throw new Error("Usage: node benchmarks/summarize-completed.mjs EXPORTED_DIAGNOSTIC_DIRECTORY")
const directory = pathToFileURL(resolve(process.argv[2]) + "/")
const run = JSON.parse(await readFile(new URL("run.json", directory), "utf8"))
assert.equal(run.status, "failed", "only failed parent experiments use a partial summary")
assert.equal(run.purpose, "incomplete-diagnostics")
assert.ok(
  run.destroyedAt && !run.downloadError && !run.cleanupError,
  "unconfirmed download or teardown",
)
assert.match(run.resultsSha256, /^[a-f0-9]{64}$/)
const result = await completedComparison(directory, run.profile.comparison)
assert.ok(
  result.completedDatabases.length < result.comparison.databases.length,
  "the whole sampling plan completed; do not label it partial",
)
await writeFile(new URL("comparison.json", directory), JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
})
const original = await readFile(new URL("README.md", directory), "utf8")
await writeFile(
  new URL("README.md", directory),
  original +
    `\nOnly the complete predeclared backend plans are summarized: ${result.completedDatabases.join(", ")}. The original failed status, full plan and every emitted report remain unchanged. No rounds or variants are selected within a backend.\n\n` +
    controlledTable(result.rows) +
    "\n",
)
console.log(`Summarized completed backends: ${result.completedDatabases.join(", ")}`)

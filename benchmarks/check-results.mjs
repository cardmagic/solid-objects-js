import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { comparisonRows } from "./comparison.mjs"

const root = new URL("./results/", import.meta.url)
const catalog = JSON.parse(await readFile(process.argv[2] ?? new URL("index.json", root), "utf8"))
assert.equal(catalog.schemaVersion, 1, "unsupported benchmark catalog")
const ids = new Set()
for (const dataset of catalog.datasets) {
  assert.match(dataset.id, /^[a-zA-Z0-9.-]+$/)
  assert.ok(!ids.has(dataset.id), "duplicate dataset")
  ids.add(dataset.id)
  assert.ok(dataset.environment, "missing environment label")
  const directory = new URL(`${dataset.id}/`, root)
  const load = async (name) => JSON.parse(await readFile(new URL(name, directory), "utf8"))
  if (dataset.kind === "controlled-comparison") {
    const run = await load("run.json")
    assert.equal(run.status, "complete", "incomplete cloud run")
    assert.ok(
      run.destroyedAt && !run.cleanupError && !run.downloadError,
      "unconfirmed teardown or download",
    )
    const result = await load("comparison.json")
    assert.deepEqual(
      result.comparison,
      run.profile.comparison,
      "comparison differs from archived profile",
    )
    const samples = await Promise.all(
      result.samples.map(async (sample) => {
        assert.match(sample.file, /^[a-zA-Z0-9.-]+\.json$/)
        return { ...sample, report: await load(sample.file) }
      }),
    )
    const versions = [...new Set(samples.map((sample) => sample.report.packageVersion))].sort()
    assert.deepEqual(versions, [...dataset.versions].sort(), "mislabeled runtime versions")
    assert.deepEqual(
      comparisonRows(samples, result.comparison),
      result.rows,
      "summary differs from raw samples",
    )
  } else {
    assert.ok(
      ["isolated-baseline", "historical-shared-host"].includes(dataset.kind),
      "unknown dataset kind",
    )
    const names = [
      "sqlite-counter",
      "sqlite-cart-outbox",
      "postgresql-counter",
      "postgresql-cart-outbox",
      "mysql-counter",
      "mysql-cart-outbox",
      "sqlite-large-state",
      "sqlite-idle",
    ]
    const reports = await Promise.all(names.map((name) => load(`${name}.json`)))
    assert.deepEqual(
      [...new Set(reports.map((report) => report.packageVersion))],
      dataset.versions,
      "mislabeled runtime version",
    )
    if (dataset.kind === "isolated-baseline") {
      const run = await load("run.json")
      assert.equal(run.status, "complete")
      assert.ok(
        run.destroyedAt && !run.cleanupError && !run.downloadError,
        "unconfirmed teardown or download",
      )
      for (const report of reports)
        assert.equal(report.source.revision, run.runtimeRevision, "wrong archived revision")
    }
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./summarize.mjs", import.meta.url)),
        ...names.map((name) => fileURLToPath(new URL(`${name}.json`, directory))),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
  }
}
console.log(`Validated ${ids.size} versioned benchmark datasets`)

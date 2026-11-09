import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { comparisonRows } from "./comparison.mjs"
import {
  assertPublishedTables,
  baselineHeadline,
  comparisonHeadline,
  controlledTable,
} from "./publication.mjs"

const writeGuide = process.argv.includes("--write-guide")
const argumentsValue = process.argv.slice(2).filter((value) => value !== "--write-guide")
const root = argumentsValue[1]
  ? pathToFileURL(resolve(argumentsValue[1]) + "/")
  : new URL("./results/", import.meta.url)
const catalog = JSON.parse(await readFile(argumentsValue[0] ?? new URL("index.json", root), "utf8"))
assert.equal(catalog.schemaVersion, 1, "unsupported benchmark catalog")
const ids = new Set()
const guideTables = new Map()
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
    const phases = result.comparison.databases.flatMap((database) =>
      Array.from({ length: result.comparison.rounds }, (_value, index) =>
        result.comparison.concurrencies.map(
          (concurrency) => `${database}-round-${index + 1}-concurrency-${concurrency}`,
        ),
      ).flat(),
    )
    await checkQuiet(directory, run, phases)
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
    assertPublishedTables(
      controlledTable(result.rows),
      await readFile(new URL("README.md", directory), "utf8"),
    )
    if (dataset.guideTable) guideTables.set(dataset.id, comparisonHeadline(result))
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
      await checkQuiet(directory, run, names)
      for (const report of reports)
        assert.equal(report.source.revision, run.runtimeRevision, "wrong archived revision")
    }
    const generated = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./summarize.mjs", import.meta.url)),
        ...names.map((name) => fileURLToPath(new URL(`${name}.json`, directory))),
      ],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    )
    assertPublishedTables(generated, await readFile(new URL("README.md", directory), "utf8"))
    if (dataset.guideTable)
      guideTables.set(
        dataset.id,
        baselineHeadline(reports.filter((report) => report.methodology.workload === "counter")),
      )
  }
}
if (guideTables.size > 0) {
  const path = new URL("../docs/benchmarks.md", import.meta.url)
  let guide = await readFile(path, "utf8")
  for (const [id, table] of guideTables) {
    const marker = `<!-- benchmark-table: ${id} -->`
    const endMarker = `<!-- /benchmark-table: ${id} -->`
    const start = guide.indexOf(marker)
    const end = guide.indexOf(endMarker, start + marker.length)
    assert.ok(start >= 0 && end > start, `missing generated guide table: ${id}`)
    const contentStart = start + marker.length
    if (writeGuide)
      guide = guide.slice(0, contentStart) + "\n\n" + table + "\n\n" + guide.slice(end)
    else assertPublishedTables(table, guide.slice(contentStart, end))
  }
  if (writeGuide) await writeFile(path, guide)
}
console.log(`Validated ${ids.size} versioned benchmark datasets`)

async function checkQuiet(directory, run, phases) {
  assert.match(run.resultsSha256, /^[a-f0-9]{64}$/, "missing downloaded archive checksum")
  const rows = (await readFile(new URL("quiet.jsonl", directory), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const limits = run.profile.quiet
  for (const phase of phases) {
    const samples = rows.filter((row) => row.phase === phase).slice(-limits.consecutiveSamples)
    assert.equal(samples.length, limits.consecutiveSamples, `missing readiness samples: ${phase}`)
    for (const sample of samples) {
      assert.equal(sample.quiet, true, `host was not ready: ${phase}`)
      assert.ok(
        sample.uptimeSeconds >= limits.minimumUptimeSeconds,
        `boot had not settled: ${phase}`,
      )
      for (const [value, maximum] of [
        [sample.cpuPercent, limits.maximumCpuPercent],
        [sample.ioWaitPercent, limits.maximumIoWaitPercent],
        [sample.stealPercent, limits.maximumStealPercent],
        [sample.diskBytesPerSecond, limits.maximumDiskBytesPerSecond],
        [sample.loadPerCpu, limits.maximumLoadPerCpu],
      ]) {
        assert.ok(
          Number.isFinite(value) && value >= 0 && value <= maximum,
          `readiness threshold exceeded: ${phase}`,
        )
      }
    }
    assert.ok(
      samples.at(-1).consecutive >= limits.consecutiveSamples,
      `incomplete quiet period: ${phase}`,
    )
  }
}

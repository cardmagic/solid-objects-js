import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const paths = process.argv.slice(2)
if (paths.length === 0) throw new Error("usage: node benchmarks/summarize.mjs <report.json> ...")
const reports = await Promise.all(
  paths.map(async (path) => ({ path, report: JSON.parse(await readFile(path, "utf8")) })),
)
const first = reports[0].report
assert.ok(first.source && first.runtime && first.dependencies, "missing report provenance")
const lines = [
  `# Version ${first.packageVersion} benchmark results`,
  "",
  "Matrix and state-size statistics are medians across the samples recorded in each report. Idle rows are single timed samples per interval. Percentiles are calculated within each sample; samples are not pooled. Raw reports retain every measured operation latency.",
  "",
  `Source: [${first.source.revision}](https://github.com/cardmagic/solid-objects-js/commit/${first.source.revision}). Runtime source is unchanged from that commit; the benchmark harness is overlaid.`,
  "",
  `Runtime: ${first.runtime.node}; ${first.runtime.platform}; ${first.runtime.cpu}; ${first.runtime.logicalCpus} logical CPUs; ${first.runtime.totalMemoryBytes / 2 ** 30} GiB RAM.`,
  "",
  `Drivers: pg ${first.dependencies.pg}, mysql2 ${first.dependencies.mysql2}.`,
  "",
  `Runtime source SHA-256: ${first.source.runtimeSourceSha256}`,
  "",
  `Built runtime SHA-256: ${first.source.runtimeArtifactSha256}`,
  "",
  `Harness SHA-256: ${first.source.harnessSha256}`,
  "",
]
for (const { path, report } of reports) {
  assert.ok(report.source && report.runtime && report.dependencies, "missing report provenance")
  assert.deepEqual(report.dependencies, first.dependencies, "mixed driver versions")
  for (const key of ["platform", "cpu", "logicalCpus", "totalMemoryBytes"]) {
    assert.equal(report.runtime[key], first.runtime[key], `mixed host ${key}`)
  }
  assert.match(report.source.revision, /^[a-f0-9]{40}$/)
  for (const key of ["runtimeSourceSha256", "runtimeArtifactSha256", "harnessSha256"]) {
    assert.match(report.source[key], /^[a-f0-9]{64}$/)
    assert.equal(report.source[key], first.source[key], `mixed ${key}`)
  }
  assert.equal(report.packageVersion, first.packageVersion, "mixed package versions")
  assert.equal(report.source.revision, first.source.revision, "mixed source commits")
  assert.equal(
    report.source.runtimeSourceSha256,
    first.source.runtimeSourceSha256,
    "mixed runtime source",
  )
  assert.equal(report.source.runtimeSourceDirty, false, "modified runtime source")
  assert.equal(report.source.harnessSha256, first.source.harnessSha256, "mixed harness source")
  assert.equal(report.runtime.node, first.runtime.node, "mixed Node versions")
  const name = path.split("/").at(-1)
  lines.push(
    `## ${report.database.adapter} ${report.methodology.workload ?? (report.methodology.sizes ? "large state" : "idle")}`,
    "",
    `Raw report: [${name}](${name})`,
    "",
    `Database version: ${report.database.version}. Durability settings: ${JSON.stringify(report.database.durability ?? "see methodology")}.`,
    "",
  )
  if (report.methodology.workload || report.methodology.sizes) {
    assert.ok(
      Number.isSafeInteger(report.methodology.repetitions) && report.methodology.repetitions > 0,
      "invalid repetition count",
    )
    lines.push(`Samples per scenario: ${report.methodology.repetitions}.`, "")
  }
  if (report.methodology.workload) {
    const groups = new Map()
    for (const row of report.results) {
      assert.equal(row.operations, report.methodology.operations)
      assert.equal(row.latenciesMilliseconds.length, report.methodology.operations)
      for (const [name, percent] of [
        ["p50", 50],
        ["p95", 95],
        ["p99", 99],
      ]) {
        assert.equal(row.latencyMilliseconds[name], percentile(row.latenciesMilliseconds, percent))
      }
      for (const latency of row.latenciesMilliseconds)
        assert.ok(Number.isFinite(latency) && latency >= 0)
      const key = `${row.topology}|${row.shape}|${row.handler}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
    assert.equal(groups.size, 12, "missing scenario")
    lines.push(
      "| Topology | Shape | Handler | ops/s | p50 ms | p95 ms | p99 ms |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    )
    for (const [key, rows] of groups) {
      assertSamples(rows, report.methodology.repetitions)
      const stats = [
        median(rows.map((r) => r.throughputPerSecond)),
        ...["p50", "p95", "p99"].map((p) => median(rows.map((r) => r.latencyMilliseconds[p]))),
      ]
      lines.push(`| ${key.split("|").join(" | ")} | ${stats.join(" | ")} |`)
    }
  } else if (report.methodology.sizes) {
    lines.push(
      "| Payload bytes | Persisted state bytes | ops/s | p50 ms | p95 ms | p99 ms |",
      "| ---: | ---: | ---: | ---: | ---: | ---: |",
    )
    for (const size of report.methodology.sizes) {
      const rows = report.results.filter((r) => r.payloadBytes === size)
      assertSamples(rows, report.methodology.repetitions)
      for (const row of rows) {
        assert.equal(row.operations, report.methodology.operations)
        assert.equal(row.latenciesMilliseconds.length, report.methodology.operations)
        for (const latency of row.latenciesMilliseconds)
          assert.ok(Number.isFinite(latency) && latency >= 0)
      }
      const stats = [
        median(rows.map((r) => r.stateBytes)),
        median(rows.map((r) => r.throughputPerSecond)),
        ...[50, 95, 99].map((p) => median(rows.map((r) => percentile(r.latenciesMilliseconds, p)))),
      ]
      lines.push(`| ${size} | ${stats.join(" | ")} |`)
    }
  } else {
    lines.push(
      "| Fast interval ms | Idle ceiling ms | polls/s | CPU percent |",
      "| ---: | ---: | ---: | ---: |",
    )
    for (const row of report.results)
      lines.push(
        `| ${row.pollingIntervalMilliseconds} | ${row.idlePollingIntervalMilliseconds} | ${row.pollsPerSecond} | ${row.idleCpuPercent} |`,
      )
  }
  lines.push("")
}
process.stdout.write(`${lines.join("\n")}\n`)

function assertSamples(rows, repetitions) {
  assert.equal(rows.length, repetitions, "missing samples")
  const samples = new Set()
  for (const row of rows) {
    assert.ok(
      Number.isSafeInteger(row.sample) && row.sample >= 1 && row.sample <= repetitions,
      "invalid sample ID",
    )
    assert.ok(!samples.has(row.sample), "duplicate sample ID")
    samples.add(row.sample)
  }
}

function median(values) {
  return percentile(values, 50)
}
function percentile(values, percent) {
  assert.ok(values.length > 0)
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)]
}

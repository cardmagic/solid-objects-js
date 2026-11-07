import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const paths = process.argv.slice(2)
if (paths.length === 0) throw new Error("usage: node benchmarks/summarize.mjs <report.json> ...")
const reports = await Promise.all(
  paths.map(async (path) => ({ path, report: JSON.parse(await readFile(path, "utf8")) })),
)
const first = reports[0].report
const lines = [
  `# Version ${first.packageVersion} benchmark results`,
  "",
  "Each statistic is the median across independent samples. Percentiles are calculated within each sample; samples are not pooled. Raw reports retain every measured operation latency.",
  "",
]
for (const { path, report } of reports) {
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
  )
  if (report.methodology.workload) {
    const groups = new Map()
    for (const row of report.results) {
      assert.equal(row.latenciesMilliseconds.length, report.methodology.operations)
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
      assert.equal(rows.length, report.methodology.repetitions)
      assert.equal(new Set(rows.map((row) => row.sample)).size, report.methodology.repetitions)
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
      assert.equal(rows.length, report.methodology.repetitions)
      for (const row of rows)
        assert.equal(row.latenciesMilliseconds.length, report.methodology.operations)
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

function median(values) {
  return percentile(values, 50)
}
function percentile(values, percent) {
  assert.ok(values.length > 0)
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)]
}

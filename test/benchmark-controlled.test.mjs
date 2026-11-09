import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { comparisonPlan, comparisonRows, validateComparison } from "../benchmarks/comparison.mjs"
import { assertPublishedTables, controlledTable } from "../benchmarks/publication.mjs"

const script = fileURLToPath(new URL("../benchmarks/check-results.mjs", import.meta.url))
const archived = JSON.parse(
  await readFile(
    new URL(
      "../benchmarks/results/v1.0.5-isolated-2026-11-08/sqlite-counter.json",
      import.meta.url,
    ),
    "utf8",
  ),
)

describe("controlled benchmark publication", () => {
  it("validates a complete controlled dataset and its published table", async () => {
    const result = await checkFixture()
    expect(result.status, result.stderr).toBe(0)
  })

  it("publishes every completed backend while keeping the parent experiment failed", async () => {
    const result = await checkFixture(makePartial)
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    [
      "missing raw round",
      (fixture) => {
        fixture.omitFiles.push(fixture.result.samples[0].file)
      },
    ],
    [
      "selected subset of rounds",
      (fixture) => {
        fixture.result.samples.pop()
      },
    ],
    [
      "wrong backend scope",
      (fixture) => {
        fixture.result.completedDatabases = ["mysql"]
      },
    ],
    [
      "rewritten original plan",
      (fixture) => {
        fixture.result.comparison = { ...fixture.result.comparison, databases: ["sqlite"] }
      },
    ],
    [
      "successful parent label",
      (fixture) => {
        fixture.run.status = "complete"
      },
    ],
    [
      "hidden failure label",
      (fixture) => {
        fixture.markdown = fixture.markdown.replace("# Incomplete fixture", "# Complete fixture")
      },
    ],
    [
      "omitted fully completed backend",
      (fixture) => {
        fixture.extraReports = fixture.result.samples.map((sample, index) => {
          const report = structuredClone(fixture.reports[index])
          report.database = { adapter: "mysql", version: "8.4.8", durability: { flush: 1 } }
          return { file: sample.file.replace("sqlite-", "mysql-"), report }
        })
      },
    ],
  ])("rejects partial publication with %s", async (_name, mutate) => {
    const result = await checkFixture((fixture) => {
      makePartial(fixture)
      mutate(fixture)
    })
    expect(result.status).not.toBe(0)
  })

  it.each([
    [
      "missing sample",
      (fixture) => {
        fixture.result.samples.pop()
      },
    ],
    [
      "duplicate sample",
      (fixture) => {
        fixture.result.samples.push(fixture.result.samples[0])
      },
    ],
    [
      "changed hardware",
      (fixture) => {
        fixture.reports[0].runtime.cpu = "different CPU"
      },
    ],
    [
      "changed artifact",
      (fixture) => {
        fixture.reports[0].source.runtimeArtifactSha256 = "f".repeat(64)
      },
    ],
    [
      "mixed harness",
      (fixture) => {
        fixture.reports[0].source.harnessSha256 = "f".repeat(64)
      },
    ],
    [
      "wrong durability",
      (fixture) => {
        fixture.reports[0].database.durability.synchronous = 1
      },
    ],
    ...Object.entries({
      workerCount: 8,
      warmIdentityCount: 101,
      pollingIntervalMilliseconds: 10,
      idlePollingIntervalMilliseconds: 500,
      latencyBoundary: "handler execution only",
      percentile: "linear interpolation",
    }).map(([key, value]) => [
      `changed ${key}`,
      (fixture) => {
        fixture.reports[0].methodology[key] = value
      },
    ]),
    [
      "wrong summary",
      (fixture) => {
        fixture.result.rows[0].ops += 1
      },
    ],
    [
      "missing readiness",
      (fixture) => {
        fixture.quiet.shift()
      },
    ],
    [
      "unconfirmed teardown",
      (fixture) => {
        delete fixture.run.destroyedAt
      },
    ],
    [
      "stale published table",
      (fixture) => {
        fixture.markdown = fixture.markdown.replace("100", "101")
      },
    ],
  ])("rejects %s", async (_name, mutate) => {
    const result = await checkFixture(mutate)
    expect(result.status).not.toBe(0)
  })

  it("rotates version order within a round", () => {
    expect(
      comparisonPlan({ variants: [{ name: "old" }, { name: "new" }] }, "sqlite", 2).map(
        (variant) => variant.name,
      ),
    ).toEqual(["new", "old"])
  })

  it("allows Markdown spacing and number formatting but rejects stale values and database labels", () => {
    const generated = "## sqlite counter\n| Shape | ops/s |\n| --- | ---: |\n| hot | 1200 |"
    const formatted =
      "Environment note.\n## sqlite counter\n| Shape  | ops/s |\n| :--- | ---: |\n| hot  | 1,200.00 |"
    expect(() => assertPublishedTables(generated, formatted)).not.toThrow()
    expect(() => assertPublishedTables(generated, formatted.replace("1,200.00", "1,201"))).toThrow()
    expect(() => assertPublishedTables(generated, formatted.replace("sqlite", "mysql"))).toThrow()
  })

  it("accepts SQLite durability that matches the synchronous option and skips server-only variants", () => {
    expect(() => validateComparison(durabilityPlan())).not.toThrow()
    expect(() =>
      validateComparison({
        ...durabilityPlan(),
        databases: ["postgresql"],
        variants: [
          { name: "old", version: "1.0.5" },
          { name: "new", version: "1.0.6" },
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    [
      "missing SQLite durability",
      (plan) => {
        delete plan.variants[0].sqliteDurability
      },
      /missing or invalid SQLite durability/,
    ],
    [
      "an unknown synchronous option",
      (plan) => {
        plan.variants[1].synchronous = "extra"
      },
      /invalid SQLite synchronous option/,
    ],
    [
      "durability that differs from the synchronous option",
      (plan) => {
        plan.variants[1].synchronous = "full"
      },
      /inconsistent SQLite durability/,
    ],
  ])("rejects %s", (_name, mutate, message) => {
    const plan = durabilityPlan()
    mutate(plan)
    expect(() => validateComparison(plan)).toThrow(message)
  })
})

function durabilityPlan() {
  return {
    databases: ["sqlite", "postgresql"],
    rounds: 3,
    operations: 3,
    warmup: 1,
    concurrencies: [16],
    variants: [
      {
        name: "old",
        version: "1.0.5",
        sqliteDurability: { journalMode: "delete", synchronous: 2 },
      },
      {
        name: "new",
        version: "1.0.6",
        synchronous: "normal",
        sqliteDurability: { journalMode: "wal", synchronous: 1 },
      },
      { name: "server", version: "1.0.6", databases: ["postgresql"] },
    ],
  }
}

function makePartial(fixture) {
  fixture.kind = "partial-controlled-comparison"
  fixture.run.status = "failed"
  fixture.run.purpose = "incomplete-diagnostics"
  fixture.run.error = "Synthetic failure in MySQL after every SQLite round completed"
  fixture.result.comparison.databases.push("mysql")
  fixture.result.completedDatabases = ["sqlite"]
  fixture.result.plannedReportCount = 12
  fixture.result.emittedReportCount = 6
  fixture.markdown = "# Incomplete fixture\n\n" + fixture.markdown
}

async function checkFixture(mutate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "so-controlled-publication-"))
  try {
    const directory = join(root, "fixture")
    await mkdir(directory)
    const comparison = {
      databases: ["sqlite"],
      rounds: 3,
      operations: 3,
      warmup: 1,
      concurrencies: [16],
      variants: [
        {
          name: "old",
          version: "1.0.5",
          revision: archived.source.revision,
          sqliteDurability: { journalMode: "delete", synchronous: 2 },
        },
        {
          name: "new",
          version: "1.0.6",
          revision: "b".repeat(40),
          sqliteDurability: { journalMode: "wal", synchronous: 1 },
        },
      ],
    }
    const samples = [1, 2, 3].flatMap((round) =>
      comparisonPlan(comparison, "sqlite", round).map((variant) => {
        const report = structuredClone(archived)
        report.packageVersion = variant.version
        report.source.revision = variant.revision
        report.database.durability = { ...variant.sqliteDurability }
        Object.assign(report.methodology, {
          operations: 3,
          warmupOperations: 1,
          repetitions: 1,
          concurrency: 16,
        })
        report.results = ["warm-hot", "warm-many", "cold-many"].map((shape) => ({
          shape,
          topology: "four-processes",
          handler: "synchronous",
          sample: 1,
          operations: 3,
          concurrency: 16,
          throughputPerSecond: 100,
          latenciesMilliseconds: [1, 2, 3],
          latencyMilliseconds: { p50: 2, p95: 3, p99: 3 },
        }))
        return {
          variant: variant.name,
          round,
          concurrency: 16,
          file: `sqlite-round-${round}-concurrency-16-${variant.name}.json`,
          report,
        }
      }),
    )
    const quietLimits = {
      minimumUptimeSeconds: 180,
      consecutiveSamples: 12,
      maximumCpuPercent: 5,
      maximumIoWaitPercent: 1,
      maximumStealPercent: 1,
      maximumDiskBytesPerSecond: 1048576,
      maximumLoadPerCpu: 0.05,
    }
    const result = {
      comparison,
      rows: comparisonRows(samples, comparison),
      samples: samples.map(({ report, ...sample }) => sample),
    }
    const fixture = {
      kind: "controlled-comparison",
      omitFiles: [],
      extraReports: [],
      result,
      reports: samples.map((sample) => sample.report),
      markdown: controlledTable(result.rows),
      run: {
        status: "complete",
        destroyedAt: "2026-11-09T00:00:00Z",
        resultsSha256: "a".repeat(64),
        profile: { comparison, quiet: quietLimits },
      },
      quiet: [1, 2, 3].flatMap((round) =>
        Array.from({ length: 12 }, (_value, index) => ({
          phase: `sqlite-round-${round}-concurrency-16`,
          quiet: true,
          uptimeSeconds: 200,
          consecutive: index + 1,
          cpuPercent: 0,
          ioWaitPercent: 0,
          stealPercent: 0,
          diskBytesPerSecond: 0,
          loadPerCpu: 0,
        })),
      ),
    }
    mutate(fixture)
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        datasets: [
          {
            id: "fixture",
            kind: fixture.kind,
            databases: fixture.result.completedDatabases,
            environment: "Synthetic validation fixture",
            versions: ["1.0.5", "1.0.6"],
          },
        ],
      }),
    )
    await writeFile(join(directory, "comparison.json"), JSON.stringify(fixture.result))
    await writeFile(join(directory, "run.json"), JSON.stringify(fixture.run))
    await writeFile(
      join(directory, "quiet.jsonl"),
      fixture.quiet.map((row) => JSON.stringify(row)).join("\n"),
    )
    await writeFile(join(directory, "README.md"), fixture.markdown)
    for (const [index, sample] of samples.entries()) {
      if (fixture.omitFiles.includes(sample.file)) continue
      await writeFile(join(directory, sample.file), JSON.stringify(fixture.reports[index]))
    }
    for (const sample of fixture.extraReports)
      await writeFile(join(directory, sample.file), JSON.stringify(sample.report))
    return spawnSync(process.execPath, [script, join(root, "index.json"), root], {
      encoding: "utf8",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../benchmarks/summarize.mjs", import.meta.url))

describe("benchmark summary CLI", () => {
  it.each([1, 3, 5])("reports the configured %i samples", (repetitions) => {
    const result = summarize(matrixReport(repetitions), largeStateReport(repetitions))
    expect(result.status, result.stderr).toBe(0)
    expect(
      result.stdout.match(new RegExp(`Samples per scenario: ${repetitions}\\.`, "g")),
    ).toHaveLength(2)
    expect(result.stdout).not.toContain("three separate samples")
  })

  it("reports different repetition counts separately", () => {
    const result = summarize(matrixReport(1), largeStateReport(5))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Samples per scenario: 1.")
    expect(result.stdout).toContain("Samples per scenario: 5.")
  })

  for (const kind of ["matrix", "large state"] as const) {
    const fixture = () => (kind === "matrix" ? matrixReport(3) : largeStateReport(3))
    it(`rejects duplicate ${kind} sample IDs`, () => {
      const report = fixture()
      report.results[2]!.sample = 2
      const result = summarize(report)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("duplicate sample ID")
    })

    it(`rejects missing ${kind} samples`, () => {
      const report = fixture()
      report.results.splice(0, 1)
      const result = summarize(report)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("missing samples")
    })

    it.each([0, 4, 1.5])(`rejects invalid ${kind} sample ID %s`, (sample) => {
      const report = fixture()
      report.results[0]!.sample = sample
      const result = summarize(report)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("invalid sample ID")
    })

    it(`accepts ${kind} samples in a different order`, () => {
      const report = fixture()
      report.results.reverse()
      const result = summarize(report)
      expect(result.status, result.stderr).toBe(0)
    })
  }

  it.each([0, 1.5])("rejects invalid repetition count %s", (repetitions) => {
    const report = largeStateReport(3)
    report.methodology.repetitions = repetitions
    const result = summarize(report)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("invalid repetition count")
  })

  it("requires built-runtime provenance", () => {
    const report = matrixReport(1)
    const source: Record<string, unknown> = { ...report.source }
    delete source.runtimeArtifactSha256
    expect(summarize({ ...report, source }).status).not.toBe(0)
  })

  it("rejects mixed built-runtime hashes", () => {
    const first = matrixReport(1)
    const second = largeStateReport(1)
    second.source.runtimeArtifactSha256 = "f".repeat(64)
    const result = summarize(first, second)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("mixed runtimeArtifactSha256")
  })

  it("continues to validate every archived report", () => {
    const directory = fileURLToPath(
      new URL("../benchmarks/results/v1.0.5-2026-11-07/", import.meta.url),
    )
    const paths = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(directory, name))
    expect(paths).toHaveLength(8)
    const result = spawnSync(process.execPath, [script, ...paths], {
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(result.status, result.stderr).toBe(0)
  })
})

function summarize(...reports: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "solid-objects-summary-"))
  try {
    const paths = reports.map((report, index) => {
      const path = join(directory, `${index}.json`)
      writeFileSync(path, JSON.stringify(report))
      return path
    })
    return spawnSync(process.execPath, [script, ...paths], { encoding: "utf8", timeout: 10_000 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function metadata() {
  return {
    packageVersion: "test",
    source: {
      revision: "a".repeat(40),
      runtimeSourceSha256: "1".repeat(64),
      runtimeArtifactSha256: "2".repeat(64),
      harnessSha256: "3".repeat(64),
      runtimeSourceDirty: false,
    },
    runtime: {
      node: process.version,
      platform: "test",
      cpu: "test",
      logicalCpus: 1,
      totalMemoryBytes: 2 ** 30,
    },
    dependencies: { pg: "test", mysql2: "test" },
    database: { adapter: "sqlite", version: "test" },
  }
}

function matrixReport(repetitions: number) {
  return {
    ...metadata(),
    methodology: { workload: "counter", repetitions, operations: 3 },
    results: ["one-process", "four-processes"].flatMap((topology) =>
      ["warm-hot", "warm-many", "cold-many"].flatMap((shape) =>
        ["synchronous", "asynchronous"].flatMap((handler) =>
          Array.from({ length: repetitions }, (_value, index) => ({
            topology,
            shape,
            handler,
            sample: index + 1,
            operations: 3,
            throughputPerSecond: 100,
            latenciesMilliseconds: [1, 2, 3],
            latencyMilliseconds: { p50: 2, p95: 3, p99: 3 },
          })),
        ),
      ),
    ),
  }
}

function largeStateReport(repetitions: number) {
  return {
    ...metadata(),
    methodology: { sizes: [0, 16], repetitions, operations: 3 },
    results: [0, 16].flatMap((payloadBytes) =>
      Array.from({ length: repetitions }, (_value, index) => ({
        payloadBytes,
        sample: index + 1,
        operations: 3,
        stateBytes: payloadBytes + 26,
        throughputPerSecond: 100,
        latenciesMilliseconds: [1, 2, 3],
      })),
    ),
  }
}

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../benchmarks/check-results.mjs", import.meta.url))
const catalog = JSON.parse(
  readFileSync(new URL("../benchmarks/results/index.json", import.meta.url), "utf8"),
) as {
  schemaVersion: number
  datasets: { id: string; kind: string; versions: string[]; environment: string }[]
}

describe("benchmark publication", () => {
  it("validates archived datasets through the publication command", () => {
    const result = check(catalog)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `Validated ${catalog.datasets.length} versioned benchmark datasets`,
    )
  })

  it("rejects relabeling measured 1.0.5 results as 1.0.6", () => {
    const fixture = structuredClone(catalog)
    fixture.datasets = [
      fixture.datasets.find((entry) => entry.id === "v1.0.5-isolated-2026-11-08")!,
    ]
    fixture.datasets[0]!.versions = ["1.0.6"]
    const result = check(fixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("mislabeled runtime version")
  })

  it("rejects duplicate dataset identities", () => {
    const fixture = structuredClone(catalog)
    fixture.datasets = [fixture.datasets[0]!, fixture.datasets[0]!]
    const result = check(fixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("duplicate dataset")
  })

  it("requires lifecycle evidence before calling a workstation run isolated", () => {
    const fixture = structuredClone(catalog)
    fixture.datasets = [fixture.datasets.find((entry) => entry.kind === "historical-shared-host")!]
    fixture.datasets[0]!.kind = "isolated-baseline"
    const result = check(fixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("run.json")
  })
})

function check(value: typeof catalog) {
  const directory = mkdtempSync(join(tmpdir(), "solid-objects-publication-"))
  try {
    const path = join(directory, "catalog.json")
    writeFileSync(path, JSON.stringify(value))
    return spawnSync(process.execPath, [script, path], { encoding: "utf8" })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

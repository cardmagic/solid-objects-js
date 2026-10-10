import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const scriptPath = path.resolve("scripts/check-compatibility-fixtures.mjs")

type Fixtures = Record<string, string>

const fixtures: Fixtures = {
  "json-values.json": '{"cases":[]}\n',
  "transmit-envelopes.json": '{"version":1}\n',
}

let workspace: string | undefined

afterEach(() => {
  if (workspace !== undefined) fs.rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

describe("compatibility fixture check", () => {
  it("passes for equal sets", () => {
    const result = compare({ javascript: fixtures, ruby: fixtures })

    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  it("fails for a changed byte", () => {
    const result = compare({
      javascript: fixtures,
      ruby: { ...fixtures, "json-values.json": '{"cases":[]}' },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("json-values.json is different")
    expect(result.stderr).not.toContain("transmit-envelopes.json")
  })

  it("fails for a file present on one side only", () => {
    const result = compare({
      javascript: { ...fixtures, "sync-timeout.json": "{}\n" },
      ruby: { ...fixtures, "telemetry-events.json": "{}\n" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`sync-timeout.json is missing from ${directoryFor("ruby")}`)
    expect(result.stderr).toContain(
      `telemetry-events.json is missing from ${directoryFor("javascript")}`,
    )
  })

  it("fails for a missing directory", () => {
    writeFixtures({ name: "javascript", files: fixtures })
    const result = runScript([directoryFor("javascript"), directoryFor("ruby")])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`${directoryFor("ruby")} is not a directory`)
  })

  it("ignores a file that is not JSON", () => {
    const result = compare({ javascript: { ...fixtures, "README.md": "notes\n" }, ruby: fixtures })

    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  it("fails when a directory is not given", () => {
    const result = runScript([])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("usage:")
  })
})

function compare({ javascript, ruby }: { javascript: Fixtures; ruby: Fixtures }) {
  writeFixtures({ name: "javascript", files: javascript })
  writeFixtures({ name: "ruby", files: ruby })

  return runScript([directoryFor("javascript"), directoryFor("ruby")])
}

function runScript(directories: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...directories], { encoding: "utf8" })
}

function writeFixtures({ name, files }: { name: string; files: Fixtures }) {
  const directory = directoryFor(name)
  fs.mkdirSync(directory)
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, fileName), content)
  }
}

function directoryFor(name: string) {
  workspace ??= fs.mkdtempSync(path.join(os.tmpdir(), "compatibility-fixtures-"))

  return path.join(workspace, name)
}

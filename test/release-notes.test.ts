import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const scriptPath = path.resolve("scripts/release-notes.mjs")

const changelog = `# Changelog

## 0.14.0 - 2026-09-01

- Add the newest thing.

## 0.13.2 - 2026-08-17

- Accept a \`key\` on \`schedule\`.
- Add a process administration query.

## 0.13.0 - 2026-08-16

- Release the oldest thing.
`

let workspace: string | undefined

afterEach(() => {
  if (workspace !== undefined) fs.rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

describe("release notes", () => {
  it("writes the changelog entry for the requested version", () => {
    const notes = releaseNotes({ version: "0.13.2" })

    expect(notes).toContain("- Accept a `key` on `schedule`.")
    expect(notes).toContain("- Add a process administration query.")
  })

  it("leaves the neighbouring entries out", () => {
    const notes = releaseNotes({ version: "0.13.2" })

    expect(notes).not.toContain("Add the newest thing")
    expect(notes).not.toContain("Release the oldest thing")
    expect(notes).not.toContain("## 0.13.0")
  })

  it("reads the oldest entry to the end of the file", () => {
    const notes = releaseNotes({ version: "0.13.0" })

    expect(notes).toContain("- Release the oldest thing.")
  })

  it("names the package and the version to install", () => {
    const notes = releaseNotes({ version: "0.13.2" })

    expect(notes).toContain("npm install solid-objects@0.13.2")
  })

  it("links the changelog entry and the correctness boundaries at the tag", () => {
    const notes = releaseNotes({ version: "0.13.2" })

    expect(notes).toContain(
      "https://github.com/cardmagic/solid-objects-js/blob/v0.13.2/CHANGELOG.md#0132---2026-08-17",
    )
    expect(notes).toContain(
      "https://github.com/cardmagic/solid-objects-js/blob/v0.13.2/docs/correctness.md",
    )
  })

  it("fails when the changelog has no entry for the version", () => {
    const result = runScript({ version: "9.9.9" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("9.9.9")
  })

  it("fails when no version is given", () => {
    const result = runScript({ version: undefined })

    expect(result.status).not.toBe(0)
  })
})

function releaseNotes({ version }: { version: string }) {
  const result = runScript({ version })
  if (result.status !== 0) throw new Error(`the script failed: ${result.stderr}`)

  return result.stdout
}

function runScript({ version }: { version: string | undefined }) {
  const directory = buildWorkspace()

  return spawnSync(process.execPath, version === undefined ? [scriptPath] : [scriptPath, version], {
    cwd: directory,
    encoding: "utf8",
  })
}

function buildWorkspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"))
  fs.writeFileSync(path.join(directory, "CHANGELOG.md"), changelog)
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "solid-objects",
      repository: { url: "git+https://github.com/cardmagic/solid-objects-js.git" },
    }),
  )
  workspace = directory

  return directory
}

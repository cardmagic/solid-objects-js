import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const guide = readFileSync(new URL("../docs/agents.md", import.meta.url), "utf8")
const packageDefinition = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, { types: string; import: string }> }

describe("agent guide", () => {
  it("names the import path of each server database adapter", () => {
    const adapters = Object.keys(packageDefinition.exports).filter(
      (path) => path.startsWith("./database/") && !path.endsWith("-wasm"),
    )
    expect(adapters).toEqual(
      expect.arrayContaining(["./database/sqlite", "./database/postgresql", "./database/mysql"]),
    )
    for (const adapter of adapters) {
      expect(guide, adapter).toContain(`"solid-objects${adapter.slice(1)}"`)
    }
  })

  it("shows how to cancel a reminder", () => {
    expect(guide).toContain('this.unschedule("expire", { key: buyer })')
  })
})

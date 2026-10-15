import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const guide = readFileSync(new URL("../docs/agents.md", import.meta.url), "utf8")
const packageDefinition = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown> }

describe("agent guide", () => {
  it("names the import path of each server database adapter", () => {
    const adapters = Object.keys(packageDefinition.exports).filter((path) =>
      /^\.\/database\/(sqlite|postgresql|mysql)$/.test(path),
    )
    expect(adapters).toHaveLength(3)
    for (const adapter of adapters) {
      expect(guide, adapter).toContain(`"solid-objects${adapter.slice(1)}"`)
    }
  })

  it("shows how to cancel a reminder", () => {
    expect(guide).toContain('this.unschedule("expire", { key: buyer })')
  })
})

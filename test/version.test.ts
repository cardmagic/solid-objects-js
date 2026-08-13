import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { VERSION } from "../src/version.js"

describe("package version", () => {
  it("matches the runtime version", () => {
    const packageDefinition = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }

    expect(VERSION).toBe(packageDefinition.version)
  })
})

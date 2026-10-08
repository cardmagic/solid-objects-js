import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const packageDefinition = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { description: string; keywords: string[]; homepage?: string; files: string[] }

describe("package metadata", () => {
  it("names the virtual actor category for TypeScript and Node.js", () => {
    expect(packageDefinition.description).toMatch(
      /SQL-backed virtual actor library for TypeScript and Node\.js/,
    )
  })

  it("keeps the existing keywords and adds the actor categories", () => {
    expect(packageDefinition.keywords).toEqual(
      expect.arrayContaining(["actors", "durable-objects", "virtual-actors", "actor-model"]),
    )
  })

  it("links the homepage to the Node page", () => {
    expect(packageDefinition.homepage).toBe("https://solidobjects.dev/js")
  })

  it("ships the documentation directory that holds the agent guides", () => {
    expect(packageDefinition.files).toContain("docs")
  })
})

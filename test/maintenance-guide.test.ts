import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const root = new URL("../", import.meta.url)
const maintainerCount = /\b(?:one|only|sole|single)\s+maintainer\b/i
const documentationPaths = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  ...readdirSync(new URL("docs/", root), { encoding: "utf8", recursive: true })
    .filter((path) => path.endsWith(".md"))
    .sort()
    .map((path) => `docs/${path}`),
]

function read(path: string): string {
  return existsSync(new URL(path, root)) ? readFileSync(new URL(path, root), "utf8") : ""
}

describe("maintenance guide", () => {
  it("is linked from the README", () => {
    expect(read("README.md")).toContain("(docs/maintenance.md)")
  })

  it("names the lead maintainer", () => {
    expect(read("docs/maintenance.md")).toMatch(/is the lead\s+maintainer/)
  })

  it("has no page in the documentation that states a count of maintainers", () => {
    const pages = documentationPaths.filter((path) => maintainerCount.test(read(path)))
    expect(pages).toEqual([])
  })

  it("tells a contributor how to start", () => {
    expect(read("docs/maintenance.md")).toContain("(../CONTRIBUTING.md)")
  })
})

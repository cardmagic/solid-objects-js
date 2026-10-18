import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const root = new URL("../", import.meta.url)
const maintainerCount =
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|only|sole|single)\s+maintainers?\b/i
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
    expect(read("docs/maintenance.md")).toMatch(
      /Lucas Carlson \(\[@cardmagic\]\(https:\/\/github\.com\/cardmagic\)\) is the lead\s+maintainer/,
    )
  })

  it("has a count pattern that finds a count of maintainers in each form", () => {
    for (const text of [
      "One maintainer.",
      "1 maintainer",
      "two maintainers",
      "the only\nmaintainer",
    ]) {
      expect(text).toMatch(maintainerCount)
    }
    for (const text of ["the lead maintainer", "wants more maintainers", "become a maintainer"]) {
      expect(text).not.toMatch(maintainerCount)
    }
  })

  it("has no page in the documentation that states a count of maintainers", () => {
    const pages = documentationPaths.filter((path) => maintainerCount.test(read(path)))
    expect(pages).toEqual([])
  })

  it("tells a contributor how to start", () => {
    expect(read("docs/maintenance.md")).toContain("(../CONTRIBUTING.md)")
  })
})

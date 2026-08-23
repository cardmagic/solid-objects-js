import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")
const documentationPaths = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/api.md",
  "docs/architecture.md",
  "docs/authorization.md",
  "docs/browser-protocol.md",
  "docs/configuration.md",
  "docs/correctness.md",
  "docs/dashboard.md",
  "docs/errors-and-recovery.md",
  "docs/fit.md",
  "docs/benchmarks.md",
  "docs/comparisons.md",
  "docs/operations.md",
  "docs/parity.md",
  "docs/releasing.md",
  "docs/state-and-lifecycle.md",
  "docs/support.md",
]

for (const documentationPath of documentationPaths) {
  const source = await readFile(resolve(repositoryRoot, documentationPath), "utf8")
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1]
    if (!link || /^(?:https?:|mailto:)/.test(link)) continue
    const [encodedTarget = "", encodedAnchor] = link.split("#", 2)
    const target = decodeURIComponent(encodedTarget)
    const anchor = encodedAnchor ? decodeURIComponent(encodedAnchor) : undefined
    const targetPath = target
      ? resolve(repositoryRoot, dirname(documentationPath), target)
      : resolve(repositoryRoot, documentationPath)
    await stat(targetPath).catch(() => {
      throw new Error(`${documentationPath} links to missing ${link}`)
    })
    if (!anchor) continue
    if (target && !target.toLowerCase().endsWith(".md")) continue
    const targetSource = target ? await readFile(targetPath, "utf8") : source
    if (!headingAnchors(targetSource).has(anchor)) {
      throw new Error(`${documentationPath} links to missing heading ${link}`)
    }
  }
}

const publicApi = await readFile(resolve(repositoryRoot, "docs/api.md"), "utf8")
const configurationReference = await readFile(
  resolve(repositoryRoot, "docs/configuration.md"),
  "utf8",
)
const entryPoints = [
  "src/index.ts",
  "src/database/sqlite.ts",
  "src/database/sqlite-wasm.ts",
  "src/database/shared-sqlite-wasm.ts",
  "src/database/postgresql.ts",
  "src/database/mysql.ts",
  "src/wake-up/redis.ts",
  "src/browser/index.ts",
  "src/browser/host.ts",
  "src/browser/tab-host.ts",
  "src/sync-bridge.ts",
  "src/web/index.ts",
]

const missingExports = []
for (const entryPoint of entryPoints) {
  const source = await readFile(resolve(repositoryRoot, entryPoint), "utf8")
  for (const name of exportedNames(source)) {
    if (!new RegExp(`\\b${name}\\b`).test(publicApi)) {
      missingExports.push(`${name} exported by ${entryPoint}`)
    }
  }
}
if (missingExports.length > 0) {
  throw new Error(`docs/api.md does not document:\n${missingExports.join("\n")}`)
}

const configurationSource = await readFile(resolve(repositoryRoot, "src/configuration.ts"), "utf8")
const configurationBody = configurationSource.match(
  /export interface SolidObjectsConfiguration \{([\s\S]*?)\n\}/,
)?.[1]
if (!configurationBody) throw new Error("SolidObjectsConfiguration could not be read")
const configurationOptions = [...configurationBody.matchAll(/^\s+(\w+)\??:/gm)].map(
  (match) => match[1],
)
for (const option of configurationOptions) {
  if (option && !new RegExp(`\\b${option}\\b`).test(configurationReference)) {
    throw new Error(`docs/configuration.md does not document ${option}`)
  }
}

function exportedNames(source) {
  const names = new Set()
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}\s+from/g)) {
    for (const item of match[1].split(",")) {
      const name = item
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1)
      if (name) names.add(name)
    }
  }
  for (const match of source.matchAll(
    /export\s+(?:class|function|interface|type|const)\s+(\w+)/g,
  )) {
    const name = match[1]
    if (name) names.add(name)
  }
  return names
}

function headingAnchors(source) {
  return new Set(
    [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
      match[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-"),
    ),
  )
}

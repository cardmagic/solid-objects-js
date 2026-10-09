import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const sourceRoot = new URL("../../src/", import.meta.url)
const packageEntries = new Map([
  ["solid-objects", "index.ts"],
  ["solid-objects/core", "core.ts"],
  ["solid-objects/database/sqlite", "database/sqlite.ts"],
])

export async function resolve(specifier, context, nextResolve) {
  const entry = packageEntries.get(specifier)
  if (entry) return { url: new URL(entry, sourceRoot).href, shortCircuit: true }
  if (!specifier.startsWith(".") || !specifier.endsWith(".js") || !context.parentURL) {
    return nextResolve(specifier, context)
  }
  const typescriptSource = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL)
  if (!existsSync(fileURLToPath(typescriptSource))) return nextResolve(specifier, context)
  return { url: typescriptSource.href, shortCircuit: true }
}

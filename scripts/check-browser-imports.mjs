import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import ts from "typescript"

const repositoryRoot = path.resolve(import.meta.dirname, "..")
const browserSafeRoots = [
  "src/browser/host.ts",
  "src/browser/index.ts",
  "src/context.ts",
  "src/database/deadline.ts",
  "src/database/sqlite-wasm.ts",
  "src/database/transaction-context.ts",
  "src/database/types.ts",
  "src/platform/context-store.ts",
  "src/platform/turn-context-store.ts",
  "src/platform/uuid.ts",
]
const forbiddenPackages = new Set(["mysql2", "pg", "redis", "ws"])

const violations = []
const visited = new Set()
const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : browserSafeRoots
for (const root of roots) visit(path.resolve(repositoryRoot, root))

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`)
  process.exitCode = 1
}

function visit(filePath) {
  if (visited.has(filePath)) return
  visited.add(filePath)
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  for (const statement of source.statements) {
    const specifier = valueImportSpecifier(statement)
    if (specifier === undefined) continue
    if (specifier.startsWith("node:") || forbiddenPackages.has(specifier)) {
      violations.push(
        `${path.relative(repositoryRoot, filePath)} imports ${specifier}, which the browser cannot load`,
      )
      continue
    }
    if (!specifier.startsWith(".")) continue
    visit(resolveRelativeImport({ from: filePath, specifier }))
  }
}

function valueImportSpecifier(statement) {
  if (!ts.isImportDeclaration(statement)) return undefined
  if (statement.importClause?.isTypeOnly) return undefined
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return undefined
  return statement.moduleSpecifier.text
}

function resolveRelativeImport(options) {
  const resolved = path.resolve(path.dirname(options.from), options.specifier)
  return resolved.replace(/\.js$/, ".ts")
}

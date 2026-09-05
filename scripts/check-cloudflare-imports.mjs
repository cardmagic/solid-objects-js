import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import ts from "typescript"

const visited = new Set()
const forbidden = new Set(["pg", "mysql2", "redis", "ws"])
visit(path.resolve("src/cloudflare/index.ts"))

function visit(file) {
  if (visited.has(file)) return
  visited.add(file)
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue
    const specifier = statement.moduleSpecifier
    if (!specifier || !ts.isStringLiteral(specifier)) continue
    const name = specifier.text
    assert(
      !forbidden.has(name) && (!name.startsWith("node:") || name === "node:async_hooks"),
      `${file} imports unsupported Cloudflare dependency ${name}`,
    )
    if (name.startsWith(".")) visit(path.resolve(path.dirname(file), name.replace(/\.js$/, ".ts")))
  }
}

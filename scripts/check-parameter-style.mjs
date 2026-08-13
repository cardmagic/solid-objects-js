import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import ts from "typescript"

const sourceDirectory = path.resolve("src")
const violations = sourceFiles(sourceDirectory).flatMap(findViolations)

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`)
  process.exitCode = 1
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(entryPath)
    return entry.name.endsWith(".ts") ? [entryPath] : []
  })
}

function findViolations(filePath) {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const violations = []

  function visit(node) {
    if (ts.isFunctionLike(node) && node.parameters.length > 2) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      const name =
        node.name?.getText(source) ??
        (ts.isConstructorDeclaration(node) ? "constructor" : "anonymous")
      violations.push(
        `${path.relative(process.cwd(), filePath)}:${position.line + 1} ${name} has ${node.parameters.length} positional parameters; use an options object`,
      )
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return violations
}

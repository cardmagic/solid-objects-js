import fs from "node:fs"
import path from "node:path"

const executablePath = path.resolve("dist/executable.js")
const executableMode = fs.statSync(executablePath).mode

if ((executableMode & 0o111) === 0) {
  throw new Error(`${executablePath} is not executable`)
}

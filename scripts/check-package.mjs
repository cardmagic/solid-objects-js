import fs from "node:fs"
import path from "node:path"

const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"))
const binaries = Object.entries(manifest.bin ?? {})

if (binaries.length === 0) {
  throw new Error("package.json declares no bin entry")
}

for (const [name, declared] of binaries) {
  const target = path.resolve(declared)
  if (!fs.existsSync(target)) {
    throw new Error(`bin ${name} points at ${declared}, which the build does not produce`)
  }
  if ((fs.statSync(target).mode & 0o111) === 0) {
    throw new Error(`${target} is not executable`)
  }
}

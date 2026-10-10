import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const directories = process.argv.slice(2)

if (directories.length !== 2) {
  process.stderr.write(
    "usage: node scripts/check-compatibility-fixtures.mjs <directory> <directory>\n",
  )
  process.exit(1)
}

const absentDirectories = directories.filter(
  (directory) => fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory() !== true,
)

if (absentDirectories.length > 0) {
  process.stderr.write(
    `${absentDirectories.map((directory) => `${directory} is not a directory`).join("\n")}\n`,
  )
  process.exit(1)
}

const fixtureNames = [
  ...new Set(
    directories.flatMap((directory) =>
      fs.readdirSync(directory).filter((name) => name.endsWith(".json")),
    ),
  ),
].sort()
const differences = fixtureNames.flatMap(findDifferences)

if (differences.length > 0) {
  process.stderr.write(`${differences.join("\n")}\n`)
  process.exitCode = 1
}

function findDifferences(name) {
  const directoriesWithoutFile = directories.filter(
    (directory) => !fs.existsSync(path.join(directory, name)),
  )
  if (directoriesWithoutFile.length > 0) {
    return directoriesWithoutFile.map((directory) => `${name} is missing from ${directory}`)
  }

  const [first, second] = directories.map((directory) =>
    fs.readFileSync(path.join(directory, name)),
  )
  if (first.equals(second)) return []

  return [`${name} is different in ${directories.join(" and ")}`]
}

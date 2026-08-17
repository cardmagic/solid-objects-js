import fs from "node:fs"
import process from "node:process"

const version = process.argv[2]

if (!version) {
  process.stderr.write("usage: node scripts/release-notes.mjs <version>\n")
  process.exit(1)
}

const entry = findEntry(fs.readFileSync("CHANGELOG.md", "utf8"), version)

if (!entry) {
  process.stderr.write(`CHANGELOG.md has no entry for ${version}\n`)
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"))
const repository = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
const tag = `v${version}`
const changelogLink = `${repository}/blob/${tag}/CHANGELOG.md#${anchor(entry.heading)}`
const correctnessLink = `${repository}/blob/${tag}/docs/correctness.md`

process.stdout.write(
  [
    entry.body,
    "",
    `Install with \`npm install ${manifest.name}@${version}\`.`,
    "",
    `See the [full changelog](${changelogLink}) and [correctness boundaries](${correctnessLink}).`,
    "",
  ].join("\n"),
)

function findEntry(changelog, releasedVersion) {
  const lines = changelog.split("\n")
  const start = lines.findIndex((line) => isHeadingFor(line, releasedVersion))
  if (start === -1) return undefined

  const remainder = lines.slice(start + 1)
  const end = remainder.findIndex((line) => line.startsWith("## "))
  const body = end === -1 ? remainder : remainder.slice(0, end)

  return { heading: heading(lines[start]), body: body.join("\n").trim() }
}

function isHeadingFor(line, releasedVersion) {
  if (!line.startsWith("## ")) return false

  const text = heading(line)

  return text === releasedVersion || text.startsWith(`${releasedVersion} `)
}

function heading(line) {
  return line.replace(/^##\s+/, "").trim()
}

function anchor(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ /g, "-")
}

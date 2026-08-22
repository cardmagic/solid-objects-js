import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

const repositoryRoot = resolve(import.meta.dirname, "..")
const packageDefinition = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))
const temporaryDirectory = await mkdtemp(join(tmpdir(), "solid-objects-package-"))
const artifactDirectory = join(temporaryDirectory, "artifact")
const projectDirectory = join(temporaryDirectory, "project")

try {
  await mkdir(artifactDirectory)
  await mkdir(projectDirectory)
  await run("pnpm", ["run", "build"], { cwd: repositoryRoot })
  const packed = JSON.parse(
    await run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactDirectory],
      { cwd: repositoryRoot },
    ),
  )[0]
  assert.equal(packed.name, "solid-objects")
  assert.equal(packed.version, packageDefinition.version)

  const packagedPaths = new Set(packed.files.map((file) => file.path))
  for (const expectedPath of [
    "dist/index.js",
    "dist/executable.js",
    "dist/examples/sqlite-quickstart.js",
    "examples/sqlite-quickstart.ts",
    "docs/correctness.md",
    "README.md",
  ]) {
    assert(packagedPaths.has(expectedPath), `package is missing ${expectedPath}`)
  }
  assert.equal(
    [...packagedPaths].some((path) => path.startsWith("src/")),
    false,
  )
  assert.equal(
    [...packagedPaths].some((path) => path.startsWith("test/")),
    false,
  )

  const tarballPath = join(artifactDirectory, packed.filename)
  await run("npm", ["init", "--yes"], { cwd: projectDirectory })
  await run("npm", ["install", "--ignore-scripts", tarballPath], { cwd: projectDirectory })

  const installedPackage = JSON.parse(
    await readFile(join(projectDirectory, "node_modules/solid-objects/package.json"), "utf8"),
  )
  assert.equal(installedPackage.version, packageDefinition.version)

  const resolvedModule = (
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "process.stdout.write(import.meta.resolve('solid-objects'))",
      ],
      { cwd: projectDirectory },
    )
  ).trim()
  assert(resolvedModule.includes("/node_modules/solid-objects/dist/index.js"))
  assert.equal(resolvedModule.startsWith(`file://${repositoryRoot}`), false)

  const quickstartJson = await run(
    join(projectDirectory, "node_modules/.bin/solid-objects"),
    ["quickstart", "--json"],
    { cwd: projectDirectory },
  )
  const result = JSON.parse(quickstartJson)
  assert.deepEqual(result, {
    sameIdentityCalls: 25,
    sameIdentityFinalState: 25,
    independentIdentitiesOverlapped: true,
    temporaryStateRemoved: true,
  })

  const quickstartReport = await run(
    join(projectDirectory, "node_modules/.bin/solid-objects"),
    ["quickstart"],
    { cwd: projectDirectory },
  )
  for (const expectedText of [
    "This command will:",
    "send 25 concurrent calls to one identity;",
    "The actor it runs:",
    "class Counter extends Actor {",
    "PASS  25 concurrent calls to one identity",
    "PASS  Two different identities ran at the same time",
    "PASS  Temporary state removed",
    "What each PASS means",
    "npm install solid-objects",
    "where would the solid-objects library be best used in this app?",
  ]) {
    assert(quickstartReport.includes(expectedText), `quickstart report is missing ${expectedText}`)
  }
  assert(
    quickstartReport.indexOf("This command will:") <
      quickstartReport.indexOf("PASS  25 concurrent calls to one identity"),
    "quickstart must state its plan before it reports results",
  )
  assert.equal(
    quickstartReport.includes("Run it now?"),
    false,
    "quickstart must not wait for an answer when stdin is not a terminal",
  )

  const piped = await run(
    "bash",
    [
      "-c",
      'set -o pipefail; "$0" quickstart | head -3',
      join(projectDirectory, "node_modules/.bin/solid-objects"),
    ],
    { cwd: projectDirectory },
  )
  assert(piped.includes("Solid Objects quickstart"), "a closed pipe must still print the heading")
} finally {
  await rm(temporaryDirectory, { recursive: true })
}

async function run(command, argumentsValue, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsValue, {
      ...options,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }
      reject(new Error(`${command} exited ${code}\n${stdout}${stderr}`))
    })
  })
}

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

  const quickstart = await run(
    join(projectDirectory, "node_modules/.bin/solid-objects"),
    ["quickstart"],
    { cwd: projectDirectory },
  )
  const result = JSON.parse(quickstart)
  assert.deepEqual(result, {
    sameIdentityCalls: 25,
    sameIdentityFinalState: 25,
    independentIdentitiesOverlapped: true,
    temporaryStateRemoved: true,
  })
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

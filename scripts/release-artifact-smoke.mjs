import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
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
    "dist/core.js",
    "dist/cloudflare/index.js",
    "dist/cloudflare/host.d.ts",
    "docs/cloudflare.md",
    "dist/executable.js",
    "dist/examples/sqlite-quickstart.js",
    "examples/sqlite-quickstart.ts",
    "docs/correctness.md",
    "docs/agents.md",
    "docs/virtual-actors.md",
    "examples/ticket-sale.ts",
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

  await writeFile(
    join(projectDirectory, "actor-operations-consumer.mts"),
    await readFile(join(repositoryRoot, "test/fixtures/actor-operations-consumer.mts")),
  )
  await run(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--exactOptionalPropertyTypes",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--skipLibCheck",
      "actor-operations-consumer.mts",
    ],
    { cwd: projectDirectory },
  )

  const installedPackage = JSON.parse(
    await readFile(join(projectDirectory, "node_modules/solid-objects/package.json"), "utf8"),
  )
  assert.equal(installedPackage.version, packageDefinition.version)

  const consumerPath = join(projectDirectory, "effect-payload-consumer.mts")
  await writeFile(
    consumerPath,
    await readFile(join(repositoryRoot, "test/fixtures/effect-payload-consumer.mts")),
  )
  await run(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--exactOptionalPropertyTypes",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2024",
      consumerPath,
    ],
    { cwd: projectDirectory },
  )

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

  const ticketSaleExample = join(projectDirectory, "ticket-sale.mts")
  await writeFile(
    ticketSaleExample,
    await readFile(join(projectDirectory, "node_modules/solid-objects/examples/ticket-sale.ts")),
  )
  const ticketSaleHolds = JSON.parse(
    await run(process.execPath, [ticketSaleExample, "hold"], {
      cwd: projectDirectory,
      env: { TICKET_DATABASE: join(projectDirectory, "tickets.sqlite3") },
    }),
  )
  assert.deepEqual(
    ticketSaleHolds.map((result) => result.held).sort(),
    [false, true],
    "exactly one concurrent hold must win the only ticket",
  )
  assert.deepEqual(
    ticketSaleHolds.map((result) => result.available),
    [0, 0],
  )

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
      env: { ...process.env, NO_COLOR: "1", ...options.env },
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

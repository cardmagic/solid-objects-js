import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { cpus, freemem, platform, release, totalmem } from "node:os"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { VERSION } from "solid-objects"

const root = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(import.meta.url)

export async function benchmarkMetadata() {
  return {
    measuredAt: new Date().toISOString(),
    packageVersion: VERSION,
    source: {
      revision: git(["rev-parse", "HEAD"]),
      runtimeSourceSha256: await hashDirectory("src", ".ts"),
      runtimeArtifactSha256: await hashDirectory("dist", ".js"),
      harnessSha256: await hashDirectory("benchmarks", ".ts"),
      // A package version is insufficient: main can contain unreleased code.
      runtimeSourceDirty: git(["status", "--porcelain", "--", "src"]) !== "",
      workingTreeDirty: git(["status", "--porcelain"]) !== "",
    },
    dependencies: {
      pg: require("pg/package.json").version as string,
      mysql2: require("mysql2/package.json").version as string,
    },
    runtime: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtReport: freemem(),
    },
  }
}

async function hashDirectory(directory: string, extension: string): Promise<string> {
  const paths = (await readdir(new URL(`../${directory}/`, import.meta.url), { recursive: true }))
    .filter((path) => path.endsWith(extension))
    .sort()
  const hash = createHash("sha256")
  for (const path of paths) {
    hash.update(path)
    hash.update("\0")
    hash.update(await readFile(new URL(`../${directory}/${path}`, import.meta.url)))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function git(argumentsValue: string[]): string {
  return execFileSync("git", argumentsValue, { cwd: root, encoding: "utf8" }).trim()
}

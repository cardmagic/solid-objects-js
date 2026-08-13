#!/usr/bin/env node

import { runCli } from "./cli.js"

const shutdown = new AbortController()
process.once("SIGINT", () => shutdown.abort())
process.once("SIGTERM", () => shutdown.abort())

runCli(process.argv.slice(2), { signal: shutdown.signal }).then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)

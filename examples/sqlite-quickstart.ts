import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Actor, createRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { createInterface } from "node:readline/promises"
import {
  answerAllowsRun,
  formatQuickstartPlan,
  formatQuickstartPrompt,
  formatQuickstartReport,
  formatQuickstartStop,
  type QuickstartSummary,
} from "./quickstart-report.js"

const SAME_IDENTITY_CALLS = 25

class Counter extends Actor {
  static override readonly actorType = "QuickstartCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }

  async pause({ milliseconds }: { milliseconds: number }): Promise<{
    startedAt: number
    finishedAt: number
  }> {
    const startedAt = performance.now()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
    return { startedAt, finishedAt: performance.now() }
  }
}

const COUNTER_SOURCE = `class Counter extends Actor {
  static override readonly actorType = "QuickstartCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }

  async pause({ milliseconds }: { milliseconds: number }) {
    const startedAt = performance.now()
    await new Promise((done) => setTimeout(done, milliseconds))
    return { startedAt, finishedAt: performance.now() }
  }
}`

async function confirmRun(options: {
  format?: "report" | "json"
  confirm?: () => boolean | Promise<boolean>
}): Promise<boolean> {
  if (options.format === "json") return true
  if (options.confirm) return options.confirm()
  if (!process.stdin.isTTY) return true
  const questions = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return answerAllowsRun(await questions.question(formatQuickstartPrompt()))
  } catch {
    return false
  } finally {
    questions.close()
  }
}

export async function runQuickstart(
  options: {
    signal?: AbortSignal
    write?: (value: string) => void
    format?: "report" | "json"
    confirm?: () => boolean | Promise<boolean>
  } = {},
): Promise<void> {
  const write = options.write ?? ((value: string) => process.stdout.write(value))
  if (options.format !== "json") {
    write(
      formatQuickstartPlan({
        sameIdentityCalls: SAME_IDENTITY_CALLS,
        actorSource: COUNTER_SOURCE,
      }),
    )
  }
  if (!(await confirmRun(options))) {
    write(formatQuickstartStop())
    return
  }
  const directory = await mkdtemp(join(tmpdir(), "solid-objects-quickstart-"))
  const databasePath = join(directory, "state.sqlite3")
  const runtime = createRuntime({
    database: sqlite({ path: databasePath }),
    workerCount: 2,
    effectWorkerCount: 0,
    reminderSchedulerCount: 0,
    retentionIntervalMilliseconds: 0,
    deadProcessCleanupIntervalMilliseconds: 0,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
  })
  const shutdown = new AbortController()
  const abort = () => shutdown.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  let running: Promise<void> | undefined
  let sameIdentityFinalState = 0
  let independentIdentitiesOverlapped = false

  try {
    runtime.register(Counter)
    await runtime.install()
    running = runtime.run(shutdown.signal)

    const counter = runtime.ref(Counter, "room-1")
    const results = await Promise.all(
      Array.from({ length: SAME_IDENTITY_CALLS }, () => counter.increment()),
    )
    assert.deepEqual(
      [...results].sort((left, right) => left - right),
      Array.from({ length: SAME_IDENTITY_CALLS }, (_value, index) => index + 1),
    )
    sameIdentityFinalState = await counter.count
    assert.equal(sameIdentityFinalState, SAME_IDENTITY_CALLS)

    const pauses = await Promise.all([
      runtime.ref(Counter, "room-2").send.pause({ milliseconds: 100 }),
      runtime.ref(Counter, "room-3").send.pause({ milliseconds: 100 }),
    ])
    const windows = await Promise.all(
      pauses.map((message) => message.wait({ timeoutMilliseconds: 5_000 })),
    )
    const firstWindow = windows[0]
    const secondWindow = windows[1]
    if (!firstWindow || !secondWindow) throw new Error("two execution windows are required")
    independentIdentitiesOverlapped =
      firstWindow.startedAt < secondWindow.finishedAt &&
      secondWindow.startedAt < firstWindow.finishedAt
    assert.equal(independentIdentitiesOverlapped, true)
  } finally {
    shutdown.abort()
    await running
    await runtime.close()
    options.signal?.removeEventListener("abort", abort)
    await rm(directory, { recursive: true })
  }

  assert.equal(existsSync(directory), false)
  const summary: QuickstartSummary = {
    sameIdentityCalls: SAME_IDENTITY_CALLS,
    sameIdentityFinalState,
    independentIdentitiesOverlapped,
    temporaryStateRemoved: true,
  }
  if (options.format === "json") {
    write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }
  write(formatQuickstartReport(summary))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runQuickstart()
}

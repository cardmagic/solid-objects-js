import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Actor, createRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

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

export async function runQuickstart(
  options: {
    signal?: AbortSignal
    write?: (value: string) => void
  } = {},
): Promise<void> {
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
    const results = await Promise.all(Array.from({ length: 25 }, () => counter.increment()))
    assert.deepEqual(
      [...results].sort((left, right) => left - right),
      Array.from({ length: 25 }, (_value, index) => index + 1),
    )
    sameIdentityFinalState = await counter.count
    assert.equal(sameIdentityFinalState, 25)

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
  const write = options.write ?? ((value: string) => process.stdout.write(value))
  write(
    `${JSON.stringify(
      {
        sameIdentityCalls: 25,
        sameIdentityFinalState,
        independentIdentitiesOverlapped,
        temporaryStateRemoved: true,
      },
      null,
      2,
    )}\n`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runQuickstart()
}

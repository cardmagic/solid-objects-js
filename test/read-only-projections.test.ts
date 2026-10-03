import { expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

class ReplacingProjection extends Actor {
  static override readonly actorType = "replacing-projection"
  action = ""

  stage({ action }: { action: string }): void {
    this.action = action
    if (action === "effect") this.emit("original")
    if (action === "commit_action") this.commitAction("original")
  }

  override observables() {
    if (!this.hasIntents()) return { action: this.action }

    this.discardIntents()
    if (this.action === "effect") this.emit("replacement")
    if (this.action === "commit_action") this.commitAction("replacement")
    return { action: this.action }
  }
}

it.each(["effect", "commit_action"])(
  "rejects observable replacement of staged %s without retrying or committing",
  async (action) => {
    const committed: string[] = []
    const runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      maxAttempts: 3,
      retryDelayMilliseconds: () => 0,
    })
    try {
      runtime.register(ReplacingProjection)
      runtime.registerCommitAction("original", () => {
        committed.push("original")
      })
      runtime.registerCommitAction("replacement", () => {
        committed.push("replacement")
      })
      await runtime.install()
      const reference = runtime.ref(ReplacingProjection, "one")
      const message = await reference.send.stage({ action })
      await runtime.worker().runUntilIdle()

      expect(await message.outcome()).toMatchObject({
        status: "dead",
        error: { name: "QueryMutatedState" },
        attempts: 1,
      })
      expect((await reference.snapshot()).action).toBe("")
      expect(committed).toEqual([])
    } finally {
      await runtime.close()
    }
  },
)

const purityActions = ["effect", "recovery", "commit_action", "reminder", "outbound", "state"]

class ReadOnlyReader extends Actor {
  static override readonly actorType = "read-only-reader"
  static queryAction: string | undefined
  static projectionAction: string | undefined
  items: string[] = []

  get read(): string[] {
    performPurityAction({ actor: this, action: ReadOnlyReader.queryAction })
    return this.items
  }

  append(): string[] {
    this.items.push("committed")
    return this.items
  }

  override observables() {
    performPurityAction({ actor: this, action: ReadOnlyReader.projectionAction })
    return { projected: this.items }
  }
}

function performPurityAction(options: { actor: ReadOnlyReader; action: string | undefined }): void {
  const { actor, action } = options
  if (action === "effect") actor.emit("unexpected")
  if (action === "recovery") actor.requestEffectRecovery({ id: "missing-effect" })
  if (action === "commit_action") actor.commitAction("unexpected")
  if (action === "reminder") actor.schedule({ at: new Date(Date.now() + 60_000) }).append()
  if (action === "outbound") actor.sendTo(ReadOnlyReader.ref("other")).append()
  if (action === "state") actor.items.push("unexpected")
}

function purityRuntime(committed: string[]): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    maxAttempts: 3,
    retryDelayMilliseconds: () => 0,
  })
  runtime.register(ReadOnlyReader)
  runtime.registerCommitAction("unexpected", () => {
    committed.push("unexpected")
  })
  return runtime
}

async function expectNoCommittedWork(options: {
  runtime: SolidObjectsRuntime
  committed: readonly string[]
}): Promise<void> {
  const { runtime, committed } = options
  const rows = (table: string) =>
    runtime.settings.database.connection((connection) =>
      connection.all<{ attempt_count?: number | bigint }>(
        `SELECT * FROM ${runtime.repository.table(table)}`,
      ),
    )
  expect((await rows("messages")).map((message) => Number(message.attempt_count))).toEqual([1])
  for (const table of ["effects", "effect_recoveries", "reminders", "broadcasts"])
    expect(await rows(table)).toEqual([])
  expect(committed).toEqual([])
  ReadOnlyReader.queryAction = undefined
  ReadOnlyReader.projectionAction = undefined
  expect((await runtime.ref(ReadOnlyReader, "one").snapshot()).items).toEqual([])
}

it.each(purityActions)(
  "rejects a query that stages %s without retrying or committing",
  async (action) => {
    const committed: string[] = []
    const runtime = purityRuntime(committed)
    try {
      await runtime.install()
      ReadOnlyReader.queryAction = action

      await expect(runtime.ref(ReadOnlyReader, "one").read).rejects.toMatchObject({
        details: { name: "QueryMutatedState" },
      })
      await expectNoCommittedWork({ runtime, committed })
    } finally {
      ReadOnlyReader.queryAction = undefined
      await runtime.close()
    }
  },
)

it.each(purityActions)(
  "rejects an observable that stages %s without retrying or committing",
  async (action) => {
    const committed: string[] = []
    const runtime = purityRuntime(committed)
    try {
      await runtime.install()
      ReadOnlyReader.projectionAction = action
      const message = await runtime.ref(ReadOnlyReader, "one").send.append()
      await runtime.worker().runUntilIdle()

      expect(await message.outcome()).toMatchObject({
        status: "dead",
        error: { name: "QueryMutatedState" },
        attempts: 1,
      })
      await expectNoCommittedWork({ runtime, committed })
    } finally {
      ReadOnlyReader.projectionAction = undefined
      await runtime.close()
    }
  },
)

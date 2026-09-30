import { expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime } from "../src/runtime.js"

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

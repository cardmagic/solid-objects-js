import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

class Mailbox extends Actor {
  static override readonly actorType = "BackgroundPickupMailbox"

  delivered = 0

  receive(): number {
    this.delivered += 1
    return this.delivered
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

function startedRuntime(): SolidObjectsRuntime {
  return createRuntime({
    database: sqlite({ path: ":memory:" }),
    pollingIntervalMilliseconds: 10,
    workerCount: 1,
    effectWorkerCount: 0,
    reminderSchedulerCount: 0,
    retentionIntervalMilliseconds: 0,
    deadProcessCleanupIntervalMilliseconds: 0,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
  })
}

describe("background pickup", () => {
  it("leaves a message ready until run() starts the roles", async () => {
    runtime = startedRuntime()
    runtime.register(Mailbox)
    await runtime.install()

    const message = await runtime.ref(Mailbox, "inbox").send.receive()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(await message.status()).toBe("ready")

    const controller = new AbortController()
    const running = runtime.run(controller.signal)
    try {
      await message.wait({ timeoutMilliseconds: 2_000 })
    } finally {
      controller.abort()
      await running
    }

    expect(await message.status()).toBe("completed")
  })
})

import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

class HelperActor extends Actor {
  static override readonly actorType = "HelperActor"

  count = 0

  increment(): void {
    this.count += 1
  }

  startWork(): void {
    this.count += 1
    this.schedule({ at: new Date(Date.now() - 1_000) }).finishWork!()
    this.emit("recordHelperEffect")
  }

  finishWork(): void {
    this.count += 1
  }

  override observables(): Record<string, unknown> {
    return { count: this.count }
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("public test helper", () => {
  it("drains selected runtime roles deterministically", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const message = await HelperActor.ref("queued").send.increment()

    expect(await runtime.testing.drain({ roles: ["actors"] })).toBe(1)
    expect(await message.status()).toBe("completed")
  })

  it("drains reminders, actors, effects, callbacks, and broadcasts", async () => {
    const effects: string[] = []
    const broadcasts: string[] = []
    runtime = configuredRuntime({
      broadcast: async ({ actorId }) => {
        broadcasts.push(actorId)
      },
    })
    runtime.registerEffect("recordHelperEffect", async (_arguments, context) => {
      effects.push(context.messageId)
    })
    await runtime.install()
    const message = await HelperActor.ref("workflow").send.startWork()

    expect(await runtime.testing.drain()).toBeGreaterThanOrEqual(4)
    expect(await HelperActor.ref("workflow").count).toBe(2)
    expect(effects).toEqual([message.id])
    expect(broadcasts.length).toBeGreaterThanOrEqual(2)
  })

  it("resets every runtime table and replaces the caller worker", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await HelperActor.ref("before").increment()
    await runtime.settings.database.connection((connection) =>
      connection.run("PRAGMA foreign_keys = OFF"),
    )

    await runtime.testing.reset()
    await runtime.settings.database.connection((connection) =>
      connection.run("PRAGMA foreign_keys = ON"),
    )

    const counts = await runtime.settings.database.connection(async (connection) => {
      const tables = [
        "dead_letters",
        "claimed_messages",
        "ready_messages",
        "broadcasts",
        "effects",
        "reminders",
        "messages",
        "instances",
        "processes",
      ]
      return Promise.all(
        tables.map(async (table) => {
          const row = await connection.get<{ count: number | bigint }>(
            `SELECT COUNT(*) AS count FROM ${runtime?.repository.table(table)}`,
          )
          return Number(row?.count)
        }),
      )
    })
    expect(counts).toEqual(Array.from({ length: 9 }, () => 0))
    expect(await HelperActor.ref("after").increment()).toBeNull()
  })

  it("rejects unknown roles", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await expect(runtime.testing.drain({ roles: ["unknown" as "actors"] })).rejects.toThrow(
      "unknown test helper role",
    )
  })
})

function configuredRuntime(
  options: { broadcast?: (event: { actorId: string }) => Promise<void> } = {},
): SolidObjectsRuntime {
  return configureSolidObjects({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
  })
}

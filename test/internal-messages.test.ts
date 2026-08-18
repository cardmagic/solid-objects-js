import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { UnknownOperation } from "../src/errors.js"

class Counter extends Actor {
  static override readonly actorType = "Counter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("enqueueInternalMessage", () => {
  it("processes an internal message even when authorizeMessage rejects every request", async () => {
    runtime = createRuntime(configuredSettings({ authorizeMessage: () => false }))
    runtime.register(Counter)
    await runtime.install()

    await runtime.enqueueInternalMessage({
      actorType: Counter.actorType,
      actorId: "c1",
      operation: "increment",
      argumentsValue: { amount: 5 },
    })

    expect(await runtime.worker().runUntilIdle()).toBe(1)
    await expect(runtime.ref(Counter, "c1").snapshot()).resolves.toMatchObject({ count: 5 })
  })

  it("still rejects an operation the actor does not define", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Counter)
    await runtime.install()

    await expect(
      runtime.enqueueInternalMessage({
        actorType: Counter.actorType,
        actorId: "c1",
        operation: "missing",
      }),
    ).rejects.toBeInstanceOf(UnknownOperation)
  })
})

describe("enqueueInternalMessageInTransaction", () => {
  it("enqueues inside a caller-supplied transaction and runs after announce", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Counter)
    await runtime.install()
    const activeRuntime = runtime

    const message = await activeRuntime.settings.database.transaction((connection) =>
      activeRuntime.enqueueInternalMessageInTransaction(connection, {
        actorType: Counter.actorType,
        actorId: "c1",
        operation: "increment",
        argumentsValue: { amount: 3 },
      }),
    )
    activeRuntime.announceInternalMessage(message)

    expect(await activeRuntime.worker().runUntilIdle()).toBe(1)
    await expect(activeRuntime.ref(Counter, "c1").snapshot()).resolves.toMatchObject({ count: 3 })
  })

  it("rolls back with the caller's transaction if the surrounding work fails", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Counter)
    await runtime.install()
    const activeRuntime = runtime

    await expect(
      activeRuntime.settings.database.transaction(async (connection) => {
        await activeRuntime.enqueueInternalMessageInTransaction(connection, {
          actorType: Counter.actorType,
          actorId: "c1",
          operation: "increment",
          argumentsValue: { amount: 3 },
        })
        throw new Error("caller failed after enqueueing")
      }),
    ).rejects.toThrow("caller failed after enqueueing")

    expect(await activeRuntime.worker().runUntilIdle()).toBe(0)
  })
})

function configuredSettings(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsConfiguration {
  return {
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 2,
    ...overrides,
  }
}

import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"

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

describe("snapshotWithIncarnation", () => {
  it("returns the same fields as snapshot() plus instanceId, revision, and createdAtMs", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Counter)
    await runtime.install()

    const reference = runtime.ref(Counter, "c1")
    await reference.increment({ amount: 4 })

    const plain = await runtime.snapshot(reference)
    const withIncarnation = await runtime.snapshotWithIncarnation(reference)

    expect(withIncarnation.snapshot).toEqual(plain)
    expect(withIncarnation.instanceId).toEqual(expect.any(String))
    expect(withIncarnation.instanceId.length).toBeGreaterThan(0)
    expect(withIncarnation.revision).toEqual(expect.any(String))
    expect(withIncarnation.createdAtMs).toEqual(expect.any(Number))
    expect(withIncarnation.createdAtMs).toBeGreaterThan(0)
  })

  it("gives a recreated actor a fresh instanceId and a createdAtMs no earlier than the original", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Counter)
    await runtime.install()

    const reference = runtime.ref(Counter, "c1")
    await reference.increment({ amount: 1 })
    const first = await runtime.snapshotWithIncarnation(reference)

    await reference.destroy()
    await reference.increment({ amount: 1 })
    const second = await runtime.snapshotWithIncarnation(reference)

    expect(second.instanceId).not.toEqual(first.instanceId)
    expect(second.createdAtMs).toBeGreaterThanOrEqual(first.createdAtMs)
  })

  it("honors authorizeQuery the same way snapshot() does", async () => {
    runtime = createRuntime(configuredSettings({ authorizeQuery: () => false }))
    runtime.register(Counter)
    await runtime.install()

    const reference = runtime.ref(Counter, "c1")

    await expect(runtime.snapshotWithIncarnation(reference)).rejects.toBeInstanceOf(Unauthorized)
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

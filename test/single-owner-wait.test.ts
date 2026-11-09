import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { ApplicationWriteForbidden } from "../src/errors.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { MAXIMUM_WAIT_MILLISECONDS, waitUntilDue } from "../src/single-owner.js"

const pollingInterval = 200

class BrokenSetup extends Actor {
  static override readonly actorType = "SingleOwnerBrokenSetup"
  static activations = 0

  work(): void {}

  protected override onActivate(): void {
    BrokenSetup.activations += 1
    throw new ApplicationWriteForbidden("setup cannot write")
  }
}

let runtime: SolidObjectsRuntime | undefined
let stopRuntime: (() => Promise<void>) | undefined

afterEach(async () => {
  await stopRuntime?.()
  stopRuntime = undefined
  await runtime?.close()
  runtime = undefined
  BrokenSetup.activations = 0
})

describe("waitUntilDue", () => {
  it("waits the maximum when nothing is due", () => {
    expect(
      waitUntilDue({ untilDueMilliseconds: undefined, pollingIntervalMilliseconds: 100 }),
    ).toBe(MAXIMUM_WAIT_MILLISECONDS)
    expect(MAXIMUM_WAIT_MILLISECONDS).toBe(86_400_000)
  })

  it("waits one millisecond past a future due time", () => {
    expect(waitUntilDue({ untilDueMilliseconds: 1, pollingIntervalMilliseconds: 100 })).toBe(2)
    expect(waitUntilDue({ untilDueMilliseconds: 500, pollingIntervalMilliseconds: 100 })).toBe(501)
  })

  it("bounds a far due time at the maximum", () => {
    expect(
      waitUntilDue({
        untilDueMilliseconds: 10 * MAXIMUM_WAIT_MILLISECONDS,
        pollingIntervalMilliseconds: 100,
      }),
    ).toBe(MAXIMUM_WAIT_MILLISECONDS)
  })

  it("falls back to the polling interval when a due time is now or has passed", () => {
    expect(waitUntilDue({ untilDueMilliseconds: 0, pollingIntervalMilliseconds: 100 })).toBe(100)
    expect(waitUntilDue({ untilDueMilliseconds: -5, pollingIntervalMilliseconds: 100 })).toBe(100)
  })
})

describe("a singleOwner worker with work that it cannot take", () => {
  it("retries a failing actor setup at its polling interval instead of spinning", async () => {
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      singleOwner: true,
      pollingIntervalMilliseconds: pollingInterval,
      idlePollingIntervalMilliseconds: pollingInterval,
      authorizeMessage: () => true,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    })
    runtime.register(BrokenSetup)
    await runtime.install()
    await runtime.ref(BrokenSetup, "broken").send.work()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)
    stopRuntime = async () => {
      controller.abort()
      await running
    }

    await new Promise((resolve) => setTimeout(resolve, 5 * pollingInterval))

    expect(BrokenSetup.activations).toBeGreaterThanOrEqual(2)
    expect(BrokenSetup.activations).toBeLessThanOrEqual(10)
  })
})

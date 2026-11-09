import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { ApplicationWriteForbidden } from "../src/errors.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { DueWait, MAXIMUM_WAIT_MILLISECONDS } from "../src/single-owner.js"

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

describe("DueWait", () => {
  it("waits the maximum when nothing is due", () => {
    const wait = new DueWait()

    expect(
      wait.milliseconds({ untilDueMilliseconds: undefined, pollingIntervalMilliseconds: 100 }),
    ).toBe(MAXIMUM_WAIT_MILLISECONDS)
    expect(MAXIMUM_WAIT_MILLISECONDS).toBe(86_400_000)
  })

  it("waits one millisecond past a future due time, bounded at the maximum", () => {
    const wait = new DueWait()

    expect(wait.milliseconds({ untilDueMilliseconds: 500, pollingIntervalMilliseconds: 100 })).toBe(
      501,
    )
    expect(
      wait.milliseconds({
        untilDueMilliseconds: 10 * MAXIMUM_WAIT_MILLISECONDS,
        pollingIntervalMilliseconds: 100,
      }),
    ).toBe(MAXIMUM_WAIT_MILLISECONDS)
  })

  it("retries a due time that is now at once, then backs off to the polling interval", () => {
    const wait = new DueWait()
    const retries = [0, -5, 0, -1, 0, 0, 0, 0, 0].map((untilDueMilliseconds) =>
      wait.milliseconds({ untilDueMilliseconds, pollingIntervalMilliseconds: 100 }),
    )

    expect(retries).toEqual([1, 2, 4, 8, 16, 32, 64, 100, 100])
  })

  it("starts the back-off again after a future due time", () => {
    const wait = new DueWait()
    for (let pass = 0; pass < 5; pass += 1) {
      wait.milliseconds({ untilDueMilliseconds: 0, pollingIntervalMilliseconds: 100 })
    }

    wait.milliseconds({ untilDueMilliseconds: 50, pollingIntervalMilliseconds: 100 })

    expect(wait.milliseconds({ untilDueMilliseconds: 0, pollingIntervalMilliseconds: 100 })).toBe(1)
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
    const afterBackOff = BrokenSetup.activations
    await new Promise((resolve) => setTimeout(resolve, 5 * pollingInterval))

    expect(BrokenSetup.activations - afterBackOff).toBeGreaterThanOrEqual(2)
    expect(BrokenSetup.activations - afterBackOff).toBeLessThanOrEqual(8)
  })
})

import { getEventListeners } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { RedriveScheduler } from "../src/redrive.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { WallClockWatch } from "../src/wall-clock-watch.js"
import { waitFor } from "../src/worker.js"

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  vi.useRealTimers()
  await runtime?.close()
  runtime = undefined
})

function abortListeners(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length
}

describe("waitFor", () => {
  it("removes its abort listener when its timer ends", async () => {
    const controller = new AbortController()

    await waitFor(1, controller.signal)

    expect(abortListeners(controller.signal)).toBe(0)
  })

  it("still ends early when the signal aborts", async () => {
    const controller = new AbortController()
    const startedAt = performance.now()
    const waiting = waitFor(60_000, controller.signal)

    controller.abort()
    await waiting

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(abortListeners(controller.signal)).toBe(0)
  })
})

describe("a long-running role that waits with waitFor", () => {
  it("keeps at most one abort listener in a wall clock watch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
    const controller = new AbortController()
    const running = new WallClockWatch({ onJump: () => {} }).run(controller.signal)

    await vi.advanceTimersByTimeAsync(600_000)

    expect(abortListeners(controller.signal)).toBeLessThanOrEqual(1)
    controller.abort()
    await running
  })

  it("keeps at most one abort listener in an idle redrive scheduler without singleOwner", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
    runtime = createRuntime({ database: sqlite({ path: ":memory:" }) })
    await runtime.install()
    const controller = new AbortController()
    const running = new RedriveScheduler(runtime).run(controller.signal)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(abortListeners(controller.signal)).toBeLessThanOrEqual(1)
    controller.abort()
    await running
  })
})

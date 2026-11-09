import { afterEach, describe, expect, it, vi } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { WallClockWatch } from "../src/wall-clock-watch.js"
import type { WakeUpRole } from "../src/wake-up.js"

const eightHours = 8 * 3_600_000

let runtime: SolidObjectsRuntime | undefined
let stopRuntime: (() => Promise<void>) | undefined

afterEach(async () => {
  await stopRuntime?.()
  stopRuntime = undefined
  vi.useRealTimers()
  await runtime?.close()
  runtime = undefined
})

function useControlledClocks(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
}

describe("WallClockWatch", () => {
  it("reports a jump of the wall clock against the process clock, as after a sleep", async () => {
    useControlledClocks()
    let jumps = 0
    const watch = new WallClockWatch({ onJump: () => (jumps += 1) })
    const controller = new AbortController()
    const running = watch.run(controller.signal)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(jumps).toBe(0)

    vi.setSystemTime(Date.now() + eightHours)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(jumps).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(jumps).toBe(1)

    vi.setSystemTime(Date.now() - eightHours)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(jumps).toBe(2)

    controller.abort()
    await running
  })

  it("wakes every role of a singleOwner runtime after a jump", async () => {
    useControlledClocks()
    runtime = createRuntime({ database: sqlite({ path: ":memory:" }), singleOwner: true })
    await runtime.install()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)
    stopRuntime = async () => {
      controller.abort()
      await running
    }
    await vi.advanceTimersByTimeAsync(1_000)
    const roles: WakeUpRole[] = ["actors", "effects", "reminders", "broadcasts"]
    const watches = await Promise.all(roles.map((role) => runtime!.watchWakeUp(role)))
    const redrive = runtime.redriveSignal.watch()

    vi.setSystemTime(Date.now() + eightHours)
    await vi.advanceTimersByTimeAsync(10_000)

    const notified = Promise.all([
      ...watches.map((watch) => watch.wait({ timeoutMilliseconds: 0 })),
      redrive.wait({ timeoutMilliseconds: 0 }),
    ])
    await vi.advanceTimersByTimeAsync(1)
    expect(await notified).toEqual([true, true, true, true, true])
  })
})

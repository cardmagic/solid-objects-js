import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import type { BroadcastEvent } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

const anHour = 3_600_000
const delay = 300
const promptly = 700

class Workbench extends Actor {
  static override readonly actorType = "SingleOwnerWorkbench"
  static flakyAttempts = 0
  static remindedAt: number[] = []

  pings = 0

  ping(): number {
    this.pings += 1
    return this.pings
  }

  emitWork(): void {
    this.emit("work")
  }

  emitFlakyWork(): void {
    this.emit("flaky-work")
  }

  remindAt(input: { at: number }): void {
    this.schedule({ at: new Date(input.at) }).remind()
  }

  remind(): void {
    Workbench.remindedAt.push(performance.now())
  }

  flaky(): number {
    Workbench.flakyAttempts += 1
    if (Workbench.flakyAttempts === 1) throw new Error("the first attempt fails")
    return Workbench.flakyAttempts
  }

  override observables(): Record<string, unknown> {
    return { pings: this.pings }
  }
}

let runtime: SolidObjectsRuntime | undefined
let stopRuntime: (() => Promise<void>) | undefined
let broadcasts: BroadcastEvent[] = []
let effectRuns: number[] = []
let flakyEffectRuns: number[] = []

afterEach(async () => {
  await stopRuntime?.()
  stopRuntime = undefined
  await runtime?.close()
  runtime = undefined
  broadcasts = []
  effectRuns = []
  flakyEffectRuns = []
  Workbench.flakyAttempts = 0
  Workbench.remindedAt = []
})

async function startedRuntime(options: { singleOwner: boolean }): Promise<SolidObjectsRuntime> {
  runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    singleOwner: options.singleOwner,
    pollingIntervalMilliseconds: anHour,
    idlePollingIntervalMilliseconds: anHour,
    retryDelayMilliseconds: () => delay,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    broadcast: async (event) => {
      broadcasts.push(event)
    },
  })
  runtime.register(Workbench)
  runtime.registerEffect("work", () => {
    effectRuns.push(performance.now())
  })
  runtime.registerEffect("flaky-work", () => {
    flakyEffectRuns.push(performance.now())
    if (flakyEffectRuns.length === 1) throw new Error("the first effect attempt fails")
  })
  await runtime.install()
  const controller = new AbortController()
  const running = runtime.run(controller.signal)
  stopRuntime = async () => {
    controller.abort()
    await running
  }
  await settled()
  return runtime
}

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

async function eventually<Value>(options: {
  read: () => Value | Promise<Value>
  until: (value: Value) => boolean
  timeoutMilliseconds: number
}): Promise<Value> {
  const deadline = performance.now() + options.timeoutMilliseconds
  let value = await options.read()
  while (!options.until(value) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    value = await options.read()
  }
  return value
}

async function databaseNow(): Promise<number> {
  return runtime!.settings.database.connection((connection) => connection.nowMilliseconds())
}

describe("a singleOwner runtime with work", () => {
  it("processes a message that is sent to an actor", async () => {
    const target = await startedRuntime({ singleOwner: true })

    const message = await target.ref(Workbench, "message").send.ping()

    expect(
      await eventually({
        read: () => message.status(),
        until: (status) => status === "completed",
        timeoutMilliseconds: promptly,
      }),
    ).toBe("completed")
  })

  it("runs an effect", async () => {
    const target = await startedRuntime({ singleOwner: true })

    await target.ref(Workbench, "effect").send.emitWork()

    expect(
      await eventually({
        read: () => effectRuns.length,
        until: (count) => count === 1,
        timeoutMilliseconds: promptly,
      }),
    ).toBe(1)
  })

  it("delivers a broadcast", async () => {
    const target = await startedRuntime({ singleOwner: true })

    await target.ref(Workbench, "broadcast").send.ping()

    const delivered = await eventually({
      read: () => broadcasts,
      until: (events) => events.length === 1,
      timeoutMilliseconds: promptly,
    })
    expect(delivered).toEqual([
      expect.objectContaining({ actorId: "broadcast", invalidations: ["pings"] }),
    ])
  })

  it("runs a reminder when it comes due", async () => {
    const target = await startedRuntime({ singleOwner: true })
    const scheduledAt = performance.now()

    await target.ref(Workbench, "reminder").send.remindAt({ at: Date.now() + delay })

    const reminded = await eventually({
      read: () => Workbench.remindedAt,
      until: (times) => times.length === 1,
      timeoutMilliseconds: delay + promptly,
    })
    expect(reminded).toHaveLength(1)
    expect(reminded[0]! - scheduledAt).toBeGreaterThanOrEqual(delay - 50)
  })

  it("retries a failed message when its retry comes due", async () => {
    const target = await startedRuntime({ singleOwner: true })

    const message = await target.ref(Workbench, "retry").send.flaky()

    expect(
      await eventually({
        read: () => message.status(),
        until: (status) => status === "completed",
        timeoutMilliseconds: delay + promptly,
      }),
    ).toBe("completed")
    expect(Workbench.flakyAttempts).toBe(2)
  })

  it("retries a failed effect when its retry comes due", async () => {
    const target = await startedRuntime({ singleOwner: true })

    await target.ref(Workbench, "effect-retry").send.emitFlakyWork()

    const runs = await eventually({
      read: () => flakyEffectRuns,
      until: (times) => times.length === 2,
      timeoutMilliseconds: delay + promptly,
    })
    expect(runs).toHaveLength(2)
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(delay - 50)
  })

  it("waits an hour for a retry without the option, which shows that the option does the work", async () => {
    const target = await startedRuntime({ singleOwner: false })

    const message = await target.ref(Workbench, "polling").send.flaky()

    expect(
      await eventually({
        read: () => message.status(),
        until: (status) => status === "completed",
        timeoutMilliseconds: delay + promptly,
      }),
    ).toBe("ready")
  })
})

describe("a due time that a later write moves earlier", () => {
  it("wakes the reminder scheduler for the earlier time", async () => {
    const target = await startedRuntime({ singleOwner: true })
    const reference = target.ref(Workbench, "moved-reminder")
    await reference.send.remindAt({ at: Date.now() + anHour })
    await settled()
    const movedAt = performance.now()

    await reference.send.remindAt({ at: Date.now() + delay })

    const reminded = await eventually({
      read: () => Workbench.remindedAt,
      until: (times) => times.length === 1,
      timeoutMilliseconds: delay + promptly,
    })
    expect(reminded).toHaveLength(1)
    expect(reminded[0]! - movedAt).toBeGreaterThanOrEqual(delay - 50)
  })

  it("wakes the actor worker for an earlier available message", async () => {
    const target = await startedRuntime({ singleOwner: true })
    const now = await databaseNow()
    const late = await target
      .ref(Workbench, "late")
      .send.with({ availableAt: new Date(now + anHour) })
      .ping()
    await settled()

    const early = await target
      .ref(Workbench, "early")
      .send.with({ availableAt: new Date(now + delay) })
      .ping()

    expect(
      await eventually({
        read: () => early.status(),
        until: (status) => status === "completed",
        timeoutMilliseconds: delay + promptly,
      }),
    ).toBe("completed")
    expect(await late.status()).toBe("ready")
  })
})

describe("a retry that a synchronous caller records", () => {
  it.each([
    { singleOwner: true, notified: true },
    { singleOwner: false, notified: false },
  ])("notifies the actor workers when singleOwner is $singleOwner", async (options) => {
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      singleOwner: options.singleOwner,
      retryDelayMilliseconds: () => anHour,
      authorizeMessage: () => true,
    })
    runtime.register(Workbench)
    await runtime.install()
    await runtime.ref(Workbench, "caller").send.flaky()
    const watch = await runtime.watchWakeUp("actors")

    expect(await runtime.worker().runOnce({ activationRetention: "release" })).toBe(1)
    await settled()

    expect(await watch.wait({ timeoutMilliseconds: 0 })).toBe(options.notified)
  })
})

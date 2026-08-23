import { Signal } from "signal-polyfill"
import { afterEach, describe, expect, it } from "vitest"
import "../src/platform/node.js"
import {
  activeLiveSubscriptionCount,
  configureLiveSignals,
  liveEntryCount,
  type LiveSignal,
} from "../src/signals.js"
import { Actor, broadcastInvalidation, broadcastValue } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"

class LiveCounter extends Actor {
  static override readonly actorType = "LiveCounter"

  count = 0
  note = "quiet"

  increment(): number {
    this.count += 1
    return this.count
  }

  annotate({ note }: { note: string }): void {
    this.note = note
  }

  override observables(): Record<string, unknown> {
    return {
      count: broadcastValue(this.count),
      note: broadcastInvalidation(this.note),
    }
  }
}

const runtimes: SolidObjectsRuntime[] = []
const watchers: Array<{
  watcher: InstanceType<typeof Signal.subtle.Watcher>
  signals: LiveSignal<unknown>[]
}> = []

afterEach(async () => {
  for (const { watcher, signals } of watchers) {
    for (const signal of signals) watcher.unwatch(signal as never)
  }
  watchers.length = 0
  await Promise.all(runtimes.map((runtime) => runtime.close()))
  runtimes.length = 0
  configureLiveSignals({ lingerMilliseconds: 50, retryMilliseconds: 50 })
  await eventually(() => activeLiveSubscriptionCount() === 0)
})

async function liveRuntime(): Promise<SolidObjectsRuntime> {
  const runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeSubscription: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
  })
  runtime.register(LiveCounter)
  runtimes.push(runtime)
  await runtime.install()
  return runtime
}

function watch(...signals: LiveSignal<unknown>[]): void {
  const watcher = new Signal.subtle.Watcher(() => {})
  for (const signal of signals) watcher.watch(signal as never)
  for (const signal of signals) (signal as { get(): unknown }).get()
  watchers.push({ watcher, signals })
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("condition never became true")
}

describe("live signals", () => {
  it("replays committed observables into a watched signal", async () => {
    const runtime = await liveRuntime()
    const counter = runtime.ref(LiveCounter, "replayed")
    await counter.increment()

    watch(counter.live.count!)
    await eventually(() => counter.live.count!.get() === 1)
  })

  it("follows later commits through the broadcast outbox", async () => {
    const runtime = await liveRuntime()
    const counter = runtime.ref(LiveCounter, "following")
    watch(counter.live.count!)
    await eventually(() => activeLiveSubscriptionCount() === 1)

    await counter.increment()
    await runtime.testing.drain({ roles: ["actors", "broadcasts"] })
    await eventually(() => counter.live.count!.get() === 1)

    await counter.increment()
    await runtime.testing.drain({ roles: ["actors", "broadcasts"] })
    await eventually(() => counter.live.count!.get() === 2)
  })

  it("keeps live.snapshot current for invalidation-only observables", async () => {
    const runtime = await liveRuntime()
    const counter = runtime.ref(LiveCounter, "noted")
    watch(counter.live.snapshot)
    await eventually(() => activeLiveSubscriptionCount() === 1)

    await counter.annotate({ note: "loud" })
    await runtime.testing.drain({ roles: ["actors", "broadcasts"] })

    await eventually(() => {
      const snapshot = counter.live.snapshot.get() as { note?: string } | undefined
      return snapshot?.note === "loud"
    })
    expect(counter.live.note!.get()).toBeUndefined()
  })

  it("ignores envelopes with stale revisions", async () => {
    const runtime = await liveRuntime()
    const counter = runtime.ref(LiveCounter, "fenced")
    watch(counter.live.count!)
    await eventually(() => activeLiveSubscriptionCount() === 1)
    await counter.increment()
    await runtime.testing.drain({ roles: ["actors", "broadcasts"] })
    await eventually(() => counter.live.count!.get() === 1)

    const incarnation = await runtime.snapshotWithIncarnation(counter)
    await runtime.realtime.publish({
      actorType: "LiveCounter",
      actorId: "fenced",
      instanceId: incarnation.instanceId,
      revision: "0",
      observables: { count: 999 },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(counter.live.count!.get()).toBe(1)
  })

  it("subscribes on first watch and releases after the linger", async () => {
    configureLiveSignals({ lingerMilliseconds: 50 })
    const runtime = await liveRuntime()
    const counter = runtime.ref(LiveCounter, "lifecycled")
    expect(activeLiveSubscriptionCount()).toBe(0)

    const watcher = new Signal.subtle.Watcher(() => {})
    watcher.watch(counter.live.count! as never)
    counter.live.count!.get()
    await eventually(() => activeLiveSubscriptionCount() === 1)

    watcher.unwatch(counter.live.count! as never)
    await eventually(() => activeLiveSubscriptionCount() === 0)

    watcher.watch(counter.live.count! as never)
    counter.live.count!.get()
    await eventually(() => activeLiveSubscriptionCount() === 1)
    watcher.unwatch(counter.live.count! as never)
  })

  it("retries after a failed subscription and recovers", async () => {
    configureLiveSignals({ lingerMilliseconds: 50, retryMilliseconds: 50 })
    let denials = 2
    const runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      authorizeSubscription: () => {
        if (denials > 0) {
          denials -= 1
          return false
        }
        return true
      },
      pollingIntervalMilliseconds: 1,
      syncPollingIntervalMilliseconds: 1,
    })
    runtime.register(LiveCounter)
    runtimes.push(runtime)
    await runtime.install()
    const counter = runtime.ref(LiveCounter, "recovering")
    await counter.increment()

    watch(counter.live.count!)
    await eventually(() => counter.live.count!.get() === 1)
    expect(denials).toBe(0)
  })

  it("evicts an idle entry from the runtime cache after the linger", async () => {
    configureLiveSignals({ lingerMilliseconds: 50 })
    const runtime = await liveRuntime()
    const counter = runtime.ref(LiveCounter, "evicted")

    const watcher = new Signal.subtle.Watcher(() => {})
    watcher.watch(counter.live.count! as never)
    counter.live.count!.get()
    await eventually(() => activeLiveSubscriptionCount() === 1)
    expect(liveEntryCount(runtime)).toBe(1)

    watcher.unwatch(counter.live.count! as never)
    await eventually(() => activeLiveSubscriptionCount() === 0)
    expect(liveEntryCount(runtime)).toBe(0)

    watcher.watch(counter.live.count! as never)
    counter.live.count!.get()
    await eventually(() => activeLiveSubscriptionCount() === 1)
    expect(liveEntryCount(runtime)).toBe(1)
    watcher.unwatch(counter.live.count! as never)
  })

  it("exposes read-only signals and a stable proxy", () => {
    const runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
    })
    runtimes.push(runtime)
    runtime.register(LiveCounter)
    const counter = runtime.ref(LiveCounter, "readonly")

    expect(counter.live).toBe(counter.live)
    expect(counter.live.count).toBe(counter.live.count)
    expect("set" in counter.live.count!).toBe(false)
  })
})

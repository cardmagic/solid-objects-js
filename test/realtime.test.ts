import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"
import type { InvalidationEnvelope } from "../src/browser/index.js"

class RealtimeCounter extends Actor {
  static override readonly actorType = "RealtimeCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
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

describe("realtime subscriptions", () => {
  it("denies subscriptions before looking up the actor type", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const send = vi.fn()
    const session = runtime.realtime.connect({ authorizationContext: {}, send })

    await expect(
      session.receive({
        version: 1,
        action: "subscribe",
        actorType: "MissingActor",
        actorId: "secret",
      }),
    ).rejects.toBeInstanceOf(Unauthorized)
    expect(send).not.toHaveBeenCalled()
  })

  it("removes a registration when committed replay cannot be built", async () => {
    runtime = configuredRuntime({ authorizeSubscription: () => true })
    await runtime.install()
    const send = vi.fn()
    const session = runtime.realtime.connect({ authorizationContext: {}, send })

    await expect(
      session.receive({
        version: 1,
        action: "subscribe",
        actorType: "MissingActor",
        actorId: "missing",
      }),
    ).rejects.toThrow("unknown actor type")
    await runtime.realtime.publish({
      actorType: "MissingActor",
      actorId: "missing",
      instanceId: "instance",
      revision: "1",
      observables: {},
    })

    expect(send).not.toHaveBeenCalled()
  })

  it("sends a committed observable snapshot without creating mailbox history", async () => {
    runtime = configuredRuntime({
      authorizeSubscription: ({ actorType, actorId, authorizationContext }) =>
        actorType === RealtimeCounter.actorType &&
        actorId === "allowed" &&
        authorizationContext === "viewer",
    })
    await runtime.install()
    await RealtimeCounter.ref("allowed").increment()
    const messageCountBefore = await countRows("messages")
    const delivered: InvalidationEnvelope[] = []
    const session = runtime.realtime.connect({
      authorizationContext: "viewer",
      send: (envelope) => {
        delivered.push(envelope)
      },
    })

    await session.receive(
      JSON.stringify({
        version: 1,
        action: "subscribe",
        actorType: RealtimeCounter.actorType,
        actorId: "allowed",
      }),
    )

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      version: 1,
      actorType: RealtimeCounter.actorType,
      actorId: "allowed",
      revision: "1",
      observables: { count: 1 },
    })
    expect(delivered[0]?.instanceId).toEqual(expect.any(String))
    expect(Object.isFrozen(delivered[0])).toBe(true)
    expect(Object.isFrozen(delivered[0]?.observables)).toBe(true)
    expect(await countRows("messages")).toBe(messageCountBefore)
  })

  it("delivers committed changes without an external broadcaster", async () => {
    runtime = configuredRuntime({ authorizeSubscription: () => true })
    await runtime.install()
    const delivered: InvalidationEnvelope[] = []
    const session = runtime.realtime.connect({
      authorizationContext: {},
      send: (envelope) => {
        delivered.push(envelope)
      },
    })
    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: RealtimeCounter.actorType,
      actorId: "live",
    })

    await RealtimeCounter.ref("live").increment()
    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(delivered.map(({ revision }) => revision)).toEqual(["0", "1"])
    expect(delivered.map(({ observables }) => observables.count)).toEqual([0, 1])
  })

  it("stops delivery after unsubscribe or connection close", async () => {
    runtime = configuredRuntime({ authorizeSubscription: () => true })
    await runtime.install()
    const first = vi.fn()
    const second = vi.fn()
    const firstSession = runtime.realtime.connect({ authorizationContext: {}, send: first })
    const secondSession = runtime.realtime.connect({ authorizationContext: {}, send: second })
    const subscription = {
      version: 1 as const,
      action: "subscribe" as const,
      actorType: RealtimeCounter.actorType,
      actorId: "departed",
    }
    await firstSession.receive(subscription)
    await secondSession.receive(subscription)
    await firstSession.receive({ ...subscription, action: "unsubscribe" })
    secondSession.close()

    await RealtimeCounter.ref("departed").increment()
    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it("fences duplicate and stale delivery within an actor incarnation", async () => {
    runtime = configuredRuntime({ authorizeSubscription: () => true })
    await runtime.install()
    const delivered: InvalidationEnvelope[] = []
    const session = runtime.realtime.connect({
      authorizationContext: {},
      send: (envelope) => {
        delivered.push(envelope)
      },
    })
    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: RealtimeCounter.actorType,
      actorId: "fenced",
    })
    const event = {
      actorType: RealtimeCounter.actorType,
      actorId: "fenced",
      instanceId: "instance",
      observables: { count: 2 },
    }

    await runtime.realtime.publish({ ...event, revision: "2" })
    await runtime.realtime.publish({ ...event, revision: "1", observables: { count: 1 } })
    await runtime.realtime.publish({ ...event, revision: "2" })

    expect(delivered.map(({ revision }) => revision)).toEqual(["0", "2"])
  })

  it("claims each actor's broadcasts in revision order", async () => {
    runtime = configuredRuntime({ authorizeSubscription: () => true })
    await runtime.install()
    await RealtimeCounter.ref("ordered").increment()
    await RealtimeCounter.ref("ordered").increment()
    await runtime.settings.database.connection(async (connection) => {
      await connection.run(
        `UPDATE ${runtime?.repository.table("broadcasts")}
         SET id = CASE state_revision WHEN 1 THEN 'z-first' ELSE 'a-second' END,
             available_at_ms = 0
         WHERE actor_id = 'ordered'`,
      )
    })
    await runtime.repository.registerProcess("first-worker", "broadcast_worker")
    await runtime.repository.registerProcess("second-worker", "broadcast_worker")

    const first = await runtime.repository.claimBroadcast("first-worker")
    const blocked = await runtime.repository.claimBroadcast("second-worker")
    expect(String(first?.state_revision)).toBe("1")
    expect(blocked).toBeUndefined()

    if (!first) throw new Error("first broadcast was not claimed")
    await runtime.repository.completeBroadcast(first)
    const second = await runtime.repository.claimBroadcast("second-worker")
    expect(String(second?.state_revision)).toBe("2")
  })

  it("isolates a failing subscriber from its siblings and durable delivery", async () => {
    const instrumentation = vi.fn()
    runtime = configuredRuntime({
      authorizeSubscription: () => true,
      instrumentation,
    })
    await runtime.install()
    const successful = vi.fn()
    let fail = false
    const failingSession = runtime.realtime.connect({
      authorizationContext: {},
      send: () => {
        if (fail) throw new Error("socket contained sensitive failure text")
      },
    })
    const successfulSession = runtime.realtime.connect({
      authorizationContext: {},
      send: successful,
    })
    const request = {
      version: 1 as const,
      action: "subscribe" as const,
      actorType: RealtimeCounter.actorType,
      actorId: "isolated",
    }
    await failingSession.receive(request)
    await successfulSession.receive(request)
    fail = true

    await RealtimeCounter.ref("isolated").increment()
    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(successful).toHaveBeenCalledTimes(2)
    expect(instrumentation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "solid_objects.subscription.delivery_failed",
        attributes: expect.objectContaining({
          actorType: RealtimeCounter.actorType,
          actorId: "isolated",
          errorName: "Error",
        }),
      }),
    )
    expect(JSON.stringify(instrumentation.mock.calls)).not.toContain("sensitive failure text")
    expect(await countRows("broadcasts", "WHERE status = 'delivered'")).toBe(1)
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  runtime = configureSolidObjects({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    ...overrides,
  })
  runtime.register(RealtimeCounter)
  return runtime
}

async function countRows(table: string, condition = ""): Promise<number> {
  const row = await runtime?.settings.database.connection((connection) =>
    connection.get<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM ${runtime?.repository.table(table)} ${condition}`,
    ),
  )
  return Number(row?.count ?? 0)
}

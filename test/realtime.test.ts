import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor, type PayloadBroadcasts } from "../src/actor.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"
import type {
  InvalidationEnvelope,
  PayloadEnvelope,
  RealtimeEnvelope,
} from "../src/browser/index.js"

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

interface PayloadViewer {
  name: string
  mayReadPayloads: boolean
}

class PayloadCounter extends Actor {
  static override readonly actorType = "PayloadCounter"
  static override readonly payloads = {
    personalized: (actor, viewer) => ({ count: actor.count, viewer: viewer.name }),
    fragile: (actor) => {
      if (actor.count === 0) throw new Error("payload contained sensitive failure text")
      return { count: actor.count }
    },
    mutating: (actor) => {
      actor.count += 1
      return { count: actor.count }
    },
  } satisfies PayloadBroadcasts<PayloadCounter, PayloadViewer>

  count = 0

  increment(): void {
    this.count += 1
  }

  override observables(): Record<string, unknown> {
    return { count: this.count }
  }
}

class PayloadOnlyCounter extends Actor {
  static override readonly actorType = "PayloadOnlyCounter"
  static override readonly payloads = {
    summary: (actor: PayloadOnlyCounter) => ({ count: actor.count }),
  } satisfies PayloadBroadcasts<PayloadOnlyCounter, unknown>

  count = 0

  increment(): void {
    this.count += 1
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
    const delivered: RealtimeEnvelope[] = []
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

    const received = invalidations(delivered)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      version: 1,
      actorType: RealtimeCounter.actorType,
      actorId: "allowed",
      revision: "1",
      observables: { count: 1 },
    })
    expect(received[0]?.instanceId).toEqual(expect.any(String))
    expect(Object.isFrozen(received[0])).toBe(true)
    expect(Object.isFrozen(received[0]?.observables)).toBe(true)
    expect(await countRows("messages")).toBe(messageCountBefore)
  })

  it("delivers committed changes without an external broadcaster", async () => {
    runtime = configuredRuntime({ authorizeSubscription: () => true })
    await runtime.install()
    const delivered: RealtimeEnvelope[] = []
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

    const received = invalidations(delivered)
    expect(received.map(({ revision }) => revision)).toEqual(["0", "1"])
    expect(received.map(({ observables }) => observables.count)).toEqual([0, 1])
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
    const delivered: RealtimeEnvelope[] = []
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

    expect(invalidations(delivered).map(({ revision }) => revision)).toEqual(["0", "2"])
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

  it("delivers personalized payloads under each subscriber context", async () => {
    runtime = configuredRuntime({
      authorizeSubscription: () => true,
      authorizeQuery: ({ operation, authorizationContext }) =>
        operation !== "personalized" || (authorizationContext as PayloadViewer).mayReadPayloads,
    })
    await runtime.install()
    const alice: RealtimeEnvelope[] = []
    const bob: RealtimeEnvelope[] = []
    const aliceSession = runtime.realtime.connect({
      authorizationContext: { name: "alice", mayReadPayloads: true } satisfies PayloadViewer,
      send: (envelope) => {
        alice.push(envelope)
      },
    })
    const bobSession = runtime.realtime.connect({
      authorizationContext: { name: "bob", mayReadPayloads: false } satisfies PayloadViewer,
      send: (envelope) => {
        bob.push(envelope)
      },
    })
    const request = {
      version: 1 as const,
      action: "subscribe" as const,
      actorType: PayloadCounter.actorType,
      actorId: "room",
      payloads: ["personalized"],
    }

    await aliceSession.receive(request)
    await bobSession.receive(request)
    await PayloadCounter.ref("room").increment()
    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(payloads(alice)).toEqual([
      expect.objectContaining({
        kind: "payload",
        name: "personalized",
        revision: "0",
        payload: { count: 0, viewer: "alice" },
      }),
      expect.objectContaining({
        kind: "payload",
        name: "personalized",
        revision: "1",
        payload: { count: 1, viewer: "alice" },
      }),
    ])
    expect(payloads(bob)).toEqual([])
    expect(invalidations(alice)).toHaveLength(2)
    expect(invalidations(bob)).toHaveLength(2)
  })

  it("confines a failing payload and retries it at a later revision", async () => {
    const instrumentation = vi.fn()
    runtime = configuredRuntime({
      authorizeSubscription: () => true,
      instrumentation,
    })
    await runtime.install()
    const delivered: RealtimeEnvelope[] = []
    const session = runtime.realtime.connect({
      authorizationContext: { name: "viewer", mayReadPayloads: true } satisfies PayloadViewer,
      send: (envelope) => {
        delivered.push(envelope)
      },
    })

    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: PayloadCounter.actorType,
      actorId: "fragile",
      payloads: ["fragile", "personalized"],
    })

    expect(payloads(delivered).map(({ name }) => name)).toEqual(["personalized"])
    expect(instrumentation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "solid_objects.payload_broadcast.failed",
        attributes: expect.objectContaining({
          actorType: PayloadCounter.actorType,
          actorId: "fragile",
          payload: "fragile",
          errorName: "Error",
        }),
      }),
    )
    expect(JSON.stringify(instrumentation.mock.calls)).not.toContain("sensitive failure text")

    await PayloadCounter.ref("fragile").increment()
    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(payloads(delivered).filter(({ name }) => name === "fragile")).toEqual([
      expect.objectContaining({ revision: "1", payload: { count: 1 } }),
    ])
  })

  it("isolates payload state mutation and replays a newly restored payload", async () => {
    const instrumentation = vi.fn()
    runtime = configuredRuntime({
      authorizeSubscription: () => true,
      instrumentation,
    })
    await runtime.install()
    const delivered: RealtimeEnvelope[] = []
    const session = runtime.realtime.connect({
      authorizationContext: { name: "viewer", mayReadPayloads: true } satisfies PayloadViewer,
      send: (envelope) => {
        delivered.push(envelope)
      },
    })
    const subscription = {
      version: 1 as const,
      action: "subscribe" as const,
      actorType: PayloadCounter.actorType,
      actorId: "resubscribed",
    }

    await session.receive({ ...subscription, payloads: ["mutating", "personalized"] })
    await session.receive(subscription)
    await session.receive({ ...subscription, payloads: ["personalized"] })

    expect(payloads(delivered).map(({ name }) => name)).toEqual(["personalized", "personalized"])
    expect(payloads(delivered).map(({ payload }) => payload)).toEqual([
      { count: 0, viewer: "viewer" },
      { count: 0, viewer: "viewer" },
    ])
    expect(instrumentation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "solid_objects.payload_broadcast.failed",
        attributes: expect.objectContaining({
          payload: "mutating",
          errorName: "QueryMutatedState",
        }),
      }),
    )
  })

  it("broadcasts state revisions for actors with payloads but no observables", async () => {
    runtime = configuredRuntime({ authorizeSubscription: () => true })
    await runtime.install()
    const delivered: RealtimeEnvelope[] = []
    const session = runtime.realtime.connect({
      authorizationContext: {},
      send: (envelope) => {
        delivered.push(envelope)
      },
    })
    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: PayloadOnlyCounter.actorType,
      actorId: "only",
      payloads: ["summary"],
    })

    await PayloadOnlyCounter.ref("only").increment()
    expect(await runtime.broadcastWorker().runUntilIdle()).toBe(1)

    expect(payloads(delivered).map(({ revision, payload }) => ({ revision, payload }))).toEqual([
      { revision: "0", payload: { count: 0 } },
      { revision: "1", payload: { count: 1 } },
    ])
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
  runtime.register(PayloadCounter)
  runtime.register(PayloadOnlyCounter)
  return runtime
}

function invalidations(envelopes: RealtimeEnvelope[]): InvalidationEnvelope[] {
  return envelopes.filter(
    (envelope): envelope is InvalidationEnvelope => envelope.kind !== "payload",
  )
}

function payloads(envelopes: RealtimeEnvelope[]): PayloadEnvelope[] {
  return envelopes.filter((envelope): envelope is PayloadEnvelope => envelope.kind === "payload")
}

async function countRows(table: string, condition = ""): Promise<number> {
  const row = await runtime?.settings.database.connection((connection) =>
    connection.get<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM ${runtime?.repository.table(table)} ${condition}`,
    ),
  )
  return Number(row?.count ?? 0)
}

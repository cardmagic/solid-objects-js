import { afterEach, describe, expect, it } from "vitest"
import "../src/platform/node.js"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import {
  receiveMirrorEnvelope,
  registerMirror,
  MIRROR_EFFECT,
  type MirrorEnvelope,
} from "../src/mirror.js"

class MirrorCounter extends Actor {
  static override readonly actorType = "MirrorCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    this.mirror().increment!({ amount })
    return this.count
  }
}

class EmitCounter extends Actor {
  static override readonly actorType = "MirrorCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    this.emit(MIRROR_EFFECT, {
      arguments: { operation: "increment", arguments: { amount } },
    })
    return this.count
  }
}

class ServerMirrorCounter extends Actor {
  static override readonly actorType = "MirrorCounter"

  count = 0
  applied: number[] = []

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    this.applied = [...this.applied, amount]
    return this.count
  }
}

class AuditLog extends Actor {
  static override readonly actorType = "AuditLog"

  events: string[] = []

  record({ eventName }: { eventName: string }): number {
    this.events = [...this.events, eventName]
    return this.events.length
  }
}

class Reporter extends Actor {
  static override readonly actorType = "Reporter"

  report({ eventName }: { eventName: string }): void {
    this.emit(MIRROR_EFFECT, {
      arguments: {
        actorType: "AuditLog",
        actorId: "audit-primary",
        operation: "record",
        arguments: { eventName },
      },
    })
  }
}

const runtimes: SolidObjectsRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()))
  runtimes.length = 0
})

function testRuntime(overrides: Partial<SolidObjectsConfiguration> = {}): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 8,
    retryDelayMilliseconds: () => 0,
    ...overrides,
  })
  runtimes.push(runtime)
  return runtime
}

async function pairedRuntimes(options: {
  transmit: (envelope: MirrorEnvelope) => Promise<void>
}): Promise<{ local: SolidObjectsRuntime; server: SolidObjectsRuntime }> {
  const local = testRuntime()
  const server = testRuntime()
  registerMirror({ runtime: local, transmit: options.transmit })
  await local.install()
  await server.install()
  return { local, server }
}

describe("sync bridge", () => {
  it("delivers emitted sync effects to the server actor", async () => {
    const delivered: MirrorEnvelope[] = []
    const { local, server } = await pairedRuntimes({
      transmit: async (envelope) => {
        delivered.push(envelope)
        await receiveMirrorEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerMirrorCounter)

    await local.ref(MirrorCounter, "counter-1").increment({ amount: 2 })
    await local.testing.drain({ roles: ["actors", "effects"] })
    await server.testing.drain({ roles: ["actors"] })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      actorType: "MirrorCounter",
      actorId: "counter-1",
      operation: "increment",
      arguments: { amount: 2 },
    })
    expect(await server.ref(ServerMirrorCounter, "counter-1").snapshot()).toEqual({
      count: 2,
      applied: [2],
    })
  })

  it("deduplicates a replayed envelope on the server", async () => {
    let captured: MirrorEnvelope | undefined
    const { local, server } = await pairedRuntimes({
      transmit: async (envelope) => {
        captured = envelope
        await receiveMirrorEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerMirrorCounter)

    await local.ref(MirrorCounter, "counter-1").increment({ amount: 3 })
    await local.testing.drain({ roles: ["actors", "effects"] })
    if (!captured) throw new Error("transmit never ran")
    await receiveMirrorEnvelope({ runtime: server, envelope: captured })
    await receiveMirrorEnvelope({ runtime: server, envelope: captured })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerMirrorCounter, "counter-1").snapshot()).toEqual({
      count: 3,
      applied: [3],
    })
  })

  it("keeps per-actor order when an early envelope fails first", async () => {
    let failuresRemaining = 1
    const { local, server } = await pairedRuntimes({
      transmit: async (envelope) => {
        const amount = Number((envelope.arguments as { amount?: number }).amount)
        if (amount === 1 && failuresRemaining > 0) {
          failuresRemaining -= 1
          throw new Error("network down")
        }
        await receiveMirrorEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerMirrorCounter)

    const counter = local.ref(MirrorCounter, "ordered")
    await counter.increment({ amount: 1 })
    await counter.increment({ amount: 2 })
    await local.testing.drain({ roles: ["actors", "effects"], maxPasses: 20 })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerMirrorCounter, "ordered").snapshot()).toEqual({
      count: 3,
      applied: [1, 2],
    })
  })

  it("recovers in order after an offline period", async () => {
    let online = false
    const { local, server } = await pairedRuntimes({
      transmit: async (envelope) => {
        if (!online) throw new Error("offline")
        await receiveMirrorEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerMirrorCounter)

    const counter = local.ref(MirrorCounter, "offline")
    await counter.increment({ amount: 1 })
    await counter.increment({ amount: 2 })
    await counter.increment({ amount: 3 })
    await local.testing.drain({ roles: ["actors", "effects"], maxPasses: 5 })
    await server.testing.drain({ roles: ["actors"] })
    expect(await server.ref(ServerMirrorCounter, "offline").snapshot()).toEqual({
      count: 0,
      applied: [],
    })

    online = true
    await local.testing.drain({ roles: ["actors", "effects"], maxPasses: 30 })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerMirrorCounter, "offline").snapshot()).toEqual({
      count: 6,
      applied: [1, 2, 3],
    })
  })

  it("delivers a raw emit the same way as mirror", async () => {
    const { local, server } = await pairedRuntimes({
      transmit: async (envelope) => {
        await receiveMirrorEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerMirrorCounter)

    await local.ref(EmitCounter, "emitted").increment({ amount: 4 })
    await local.testing.drain({ roles: ["actors", "effects"] })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerMirrorCounter, "emitted").snapshot()).toEqual({
      count: 4,
      applied: [4],
    })
  })

  it("routes an explicit target to a different server actor", async () => {
    const { local, server } = await pairedRuntimes({
      transmit: async (envelope) => {
        await receiveMirrorEnvelope({ runtime: server, envelope })
      },
    })
    server.register(AuditLog)

    await local.ref(Reporter, "reporter-1").report({ eventName: "signed_in" })
    await local.testing.drain({ roles: ["actors", "effects"] })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(AuditLog, "audit-primary").snapshot()).toEqual({
      events: ["signed_in"],
    })
  })

  it("rejects a malformed envelope on the server", async () => {
    const server = testRuntime()
    await server.install()
    server.register(MirrorCounter)

    await expect(
      receiveMirrorEnvelope({
        runtime: server,
        envelope: {
          effectId: "effect-1",
          actorType: "MirrorCounter",
          actorId: "counter-1",
          operation: "",
          arguments: {},
        },
      }),
    ).rejects.toThrow()
  })
})

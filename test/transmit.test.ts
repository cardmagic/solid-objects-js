import { afterEach, describe, expect, it } from "vitest"
import "../src/platform/node.js"
import { Actor } from "../src/actor.js"
import { IdempotencyConflict } from "../src/errors.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import {
  receiveTransmitEnvelope,
  registerTransmit,
  TRANSMIT_EFFECT,
  type TransmitEnvelope,
} from "../src/transmit.js"

class TransmitCounter extends Actor {
  static override readonly actorType = "TransmitCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    this.transmit().increment!({ amount })
    return this.count
  }
}

class EmitCounter extends Actor {
  static override readonly actorType = "TransmitCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    this.emit(TRANSMIT_EFFECT, {
      arguments: { operation: "increment", arguments: { amount } },
    })
    return this.count
  }
}

class ServerTransmitCounter extends Actor {
  static override readonly actorType = "TransmitCounter"

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
    this.emit(TRANSMIT_EFFECT, {
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
  deliver: (envelope: TransmitEnvelope) => Promise<void>
}): Promise<{ local: SolidObjectsRuntime; server: SolidObjectsRuntime }> {
  const local = testRuntime()
  const server = testRuntime()
  registerTransmit({ runtime: local, deliver: options.deliver })
  await local.install()
  await server.install()
  return { local, server }
}

describe("sync bridge", () => {
  it("delivers staged transmit effects to the server actor", async () => {
    const delivered: TransmitEnvelope[] = []
    const { local, server } = await pairedRuntimes({
      deliver: async (envelope) => {
        delivered.push(envelope)
        await receiveTransmitEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerTransmitCounter)

    await local.ref(TransmitCounter, "counter-1").increment({ amount: 2 })
    await local.testing.drain({ roles: ["actors", "effects"] })
    await server.testing.drain({ roles: ["actors"] })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      actorType: "TransmitCounter",
      actorId: "counter-1",
      operation: "increment",
      arguments: { amount: 2 },
    })
    expect(await server.ref(ServerTransmitCounter, "counter-1").snapshot()).toEqual({
      count: 2,
      applied: [2],
    })
  })

  it("deduplicates a replayed envelope on the server", async () => {
    let captured: TransmitEnvelope | undefined
    const { local, server } = await pairedRuntimes({
      deliver: async (envelope) => {
        captured = envelope
        await receiveTransmitEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerTransmitCounter)

    await local.ref(TransmitCounter, "counter-1").increment({ amount: 3 })
    await local.testing.drain({ roles: ["actors", "effects"] })
    if (!captured) throw new Error("deliver never ran")
    await receiveTransmitEnvelope({ runtime: server, envelope: captured })
    await receiveTransmitEnvelope({ runtime: server, envelope: captured })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerTransmitCounter, "counter-1").snapshot()).toEqual({
      count: 3,
      applied: [3],
    })
  })

  it("keeps per-actor order when an early envelope fails first", async () => {
    let failuresRemaining = 1
    const { local, server } = await pairedRuntimes({
      deliver: async (envelope) => {
        const amount = Number((envelope.arguments as { amount?: number }).amount)
        if (amount === 1 && failuresRemaining > 0) {
          failuresRemaining -= 1
          throw new Error("network down")
        }
        await receiveTransmitEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerTransmitCounter)

    const counter = local.ref(TransmitCounter, "ordered")
    await counter.increment({ amount: 1 })
    await counter.increment({ amount: 2 })
    await local.testing.drain({ roles: ["actors", "effects"], maxPasses: 20 })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerTransmitCounter, "ordered").snapshot()).toEqual({
      count: 3,
      applied: [1, 2],
    })
  })

  it("recovers in order after an offline period", async () => {
    let online = false
    const { local, server } = await pairedRuntimes({
      deliver: async (envelope) => {
        if (!online) throw new Error("offline")
        await receiveTransmitEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerTransmitCounter)

    const counter = local.ref(TransmitCounter, "offline")
    await counter.increment({ amount: 1 })
    await counter.increment({ amount: 2 })
    await counter.increment({ amount: 3 })
    await local.testing.drain({ roles: ["actors", "effects"], maxPasses: 5 })
    await server.testing.drain({ roles: ["actors"] })
    expect(await server.ref(ServerTransmitCounter, "offline").snapshot()).toEqual({
      count: 0,
      applied: [],
    })

    online = true
    await local.testing.drain({ roles: ["actors", "effects"], maxPasses: 30 })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerTransmitCounter, "offline").snapshot()).toEqual({
      count: 6,
      applied: [1, 2, 3],
    })
  })

  it("delivers a raw emit the same way as transmit", async () => {
    const { local, server } = await pairedRuntimes({
      deliver: async (envelope) => {
        await receiveTransmitEnvelope({ runtime: server, envelope })
      },
    })
    server.register(ServerTransmitCounter)

    await local.ref(EmitCounter, "emitted").increment({ amount: 4 })
    await local.testing.drain({ roles: ["actors", "effects"] })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerTransmitCounter, "emitted").snapshot()).toEqual({
      count: 4,
      applied: [4],
    })
  })

  it("routes an explicit target to a different server actor", async () => {
    const { local, server } = await pairedRuntimes({
      deliver: async (envelope) => {
        await receiveTransmitEnvelope({ runtime: server, envelope })
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

  it("accepts an envelope without arguments, matching the Ruby ingest", async () => {
    const server = testRuntime()
    await server.install()
    server.register(ServerTransmitCounter)

    await receiveTransmitEnvelope({
      runtime: server,
      envelope: {
        effectId: "effect-no-arguments",
        actorType: "TransmitCounter",
        actorId: "defaulted",
        operation: "increment",
      } as never,
    })
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerTransmitCounter, "defaulted").snapshot()).toEqual({
      count: 1,
      applied: [1],
    })
  })

  it("raises IdempotencyConflict when a replay changes the arguments", async () => {
    const server = testRuntime()
    await server.install()
    server.register(ServerTransmitCounter)
    const envelope = {
      effectId: "effect-conflict",
      actorType: "TransmitCounter",
      actorId: "conflicted",
      operation: "increment",
      arguments: { amount: 1 },
    }

    await receiveTransmitEnvelope({ runtime: server, envelope })
    await expect(
      receiveTransmitEnvelope({
        runtime: server,
        envelope: { ...envelope, arguments: { amount: 2 } },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflict)
    await server.testing.drain({ roles: ["actors"] })

    expect(await server.ref(ServerTransmitCounter, "conflicted").snapshot()).toEqual({
      count: 1,
      applied: [1],
    })
  })

  it("rejects a malformed envelope on the server", async () => {
    const server = testRuntime()
    await server.install()
    server.register(TransmitCounter)

    await expect(
      receiveTransmitEnvelope({
        runtime: server,
        envelope: {
          effectId: "effect-1",
          actorType: "TransmitCounter",
          actorId: "counter-1",
          operation: "",
          arguments: {},
        },
      }),
    ).rejects.toThrow()
  })
})

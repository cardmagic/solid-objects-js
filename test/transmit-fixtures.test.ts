import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import "../src/platform/node.js"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"
import {
  receiveTransmitEnvelope,
  registerTransmit,
  type TransmitEnvelope,
} from "../src/transmit.js"
import { InvalidPayload } from "../src/errors.js"

interface FixtureFile {
  valid: Array<{ name: string; envelope: TransmitEnvelope; idempotencyKey: string }>
  duplicatePair: TransmitEnvelope[]
  malformed: Array<{ name: string; envelope: TransmitEnvelope }>
}

const fixtures: FixtureFile = JSON.parse(
  readFileSync(new URL("../compatibility/transmit-envelopes.json", import.meta.url), "utf8"),
)

class TransmitCounter extends Actor {
  static override readonly actorType = "transmit-counters"

  value = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.value += amount
    this.transmit().increment!({ amount })
    return this.value
  }
}

const runtimes: SolidObjectsRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()))
  runtimes.length = 0
})

async function fixtureRuntime(): Promise<SolidObjectsRuntime> {
  const runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 8,
    retryDelayMilliseconds: () => 0,
  })
  runtimes.push(runtime)
  await runtime.install()
  runtime.register(TransmitCounter)
  return runtime
}

describe("shared transmit envelope fixtures", () => {
  it("accepts every valid fixture envelope exactly once", async () => {
    const runtime = await fixtureRuntime()

    for (const fixture of fixtures.valid) {
      const first = await receiveTransmitEnvelope({ runtime, envelope: fixture.envelope })
      const replay = await receiveTransmitEnvelope({ runtime, envelope: fixture.envelope })
      expect(replay.messageId, fixture.name).toBe(first.messageId)
    }
    await runtime.testing.drain({ roles: ["actors"] })

    expect(await runtime.ref(TransmitCounter, "fixture-counter").snapshot()).toEqual({
      value: 3,
    })
  })

  it("applies the duplicate fixture pair once", async () => {
    const runtime = await fixtureRuntime()

    const results = []
    for (const envelope of fixtures.duplicatePair) {
      results.push(await receiveTransmitEnvelope({ runtime, envelope }))
    }
    await runtime.testing.drain({ roles: ["actors"] })

    expect(new Set(results.map((result) => result.messageId)).size).toBe(1)
    expect(await runtime.ref(TransmitCounter, "fixture-counter").snapshot()).toEqual({
      value: 1,
    })
  })

  it("rejects every malformed fixture envelope", async () => {
    const runtime = await fixtureRuntime()

    for (const fixture of fixtures.malformed) {
      await expect(
        receiveTransmitEnvelope({ runtime, envelope: fixture.envelope }),
        fixture.name,
      ).rejects.toThrow(InvalidPayload)
    }
  })

  it("stages an envelope that matches the fixture byte for byte", async () => {
    const runtime = await fixtureRuntime()
    const delivered: TransmitEnvelope[] = []
    registerTransmit({
      runtime,
      deliver: async (envelope) => {
        delivered.push(envelope)
      },
    })

    await runtime.ref(TransmitCounter, "fixture-counter").increment({ amount: 2 })
    await runtime.testing.drain({ roles: ["actors", "effects"] })

    const fixture = fixtures.valid[0]!
    const { effectId, ...staged } = delivered[0]!
    const { effectId: fixtureEffectId, ...expected } = fixture.envelope
    expect(staged).toEqual(expected)
    expect(fixture.idempotencyKey).toBe(`transmit:${fixtureEffectId}`)
    expect(effectId).not.toHaveLength(0)
  })
})

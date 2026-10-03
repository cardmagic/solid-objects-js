import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { Actor, type PayloadBroadcasts } from "../src/actor.js"
import type { RealtimeEnvelope } from "../src/browser/index.js"
import type { InstrumentationEvent } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { expectPortableEvents } from "./support/portable-telemetry.js"

class PayloadReader extends Actor {
  static override readonly actorType = "payload-projection"
  static override readonly payloads = {
    impure: (actor, action) => {
      switch (action) {
        case "state":
          actor.items.push("unexpected")
          break
        case "effect":
          actor.emit("unexpected")
          break
        case "recovery":
          actor.requestEffectRecovery({ id: "missing-effect" })
          break
        case "commit_action":
          actor.commitAction("unexpected")
          break
        case "reminder":
          actor.schedule({ at: new Date(Date.now() + 60_000) }).append()
          break
        case "outbound":
          actor.sendTo(PayloadReader.ref("other")).append()
          break
        case "raise":
          actor.items.push("unexpected")
          throw new Error("projection failed")
      }
      return { items: actor.items }
    },
    pure: (actor) => ({ items: actor.items }),
    text: (_actor, text) => ({ text }),
  } satisfies PayloadBroadcasts<PayloadReader, string>

  items: string[] = []

  append(): void {
    this.items.push("committed")
  }
}

let runtime: SolidObjectsRuntime | undefined

class GeneratedDefaults extends Actor {
  static override readonly actorType = "payload-generated-defaults"
  static override readonly payloads = {
    first: (actor) => ({ token: actor.token }),
    second: (actor) => ({ token: actor.token }),
  } satisfies PayloadBroadcasts<GeneratedDefaults, unknown>

  token = randomUUID()
}

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

it.each(["state", "effect", "recovery", "commit_action", "reminder", "outbound", "raise"])(
  "isolates a payload that performs %s from later projections",
  async (action) => {
    const events: InstrumentationEvent[] = []
    const configured = await startRuntime({ events })
    await configured.ref(PayloadReader, "one").append()

    const delivered = await subscribe({
      authorizationContext: action,
      payloads: ["impure", "pure"],
    })

    expect(delivered).toEqual([
      expect.objectContaining({ name: "pure", payload: { items: ["committed"] } }),
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        name: "solid_objects.payload_broadcast.failed",
        attributes: expect.objectContaining({
          payload: "impure",
          errorName: action === "raise" ? "Error" : "QueryMutatedState",
        }),
      }),
    )
    expectPortableEvents(events, ["payload_broadcast.failed"])
    expect(await configured.ref(PayloadReader, "one").snapshot()).toEqual({ items: ["committed"] })
  },
)

it.each([0, -1])(
  "enforces the configured UTF-8 payload byte boundary with offset %s",
  async (offset) => {
    const text = "éé"
    const events: InstrumentationEvent[] = []
    await startRuntime({
      events,
      maxPayloadBytes: Buffer.byteLength(JSON.stringify({ text })) + offset,
    })

    const delivered = await subscribe({ authorizationContext: text, payloads: ["text"] })

    if (offset === 0) {
      expect(delivered).toEqual([expect.objectContaining({ payload: { text } })])
      return
    }
    expect(delivered).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        name: "solid_objects.payload_broadcast.failed",
        attributes: expect.objectContaining({ errorName: "PayloadTooLarge" }),
      }),
    )
  },
)

it("accepts a configured payload limit above one megabyte", async () => {
  const text = "x".repeat(1_048_576)
  await startRuntime({ events: [], maxPayloadBytes: Buffer.byteLength(JSON.stringify({ text })) })

  const delivered = await subscribe({ authorizationContext: text, payloads: ["text"] })

  expect(delivered).toEqual([expect.objectContaining({ payload: { text } })])
})

it("shares generated defaults across payloads from the same snapshot", async () => {
  const configured = await startRuntime({ events: [] })
  configured.register(GeneratedDefaults)
  const delivered: RealtimeEnvelope[] = []
  const session = configured.realtime.connect({
    authorizationContext: null,
    send: (envelope) => {
      delivered.push(envelope)
    },
  })
  try {
    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: GeneratedDefaults.actorType,
      actorId: "new",
      payloads: ["first", "second"],
    })
    const payloads = delivered.filter((envelope) => envelope.kind === "payload")
    expect(payloads).toHaveLength(2)
    expect(payloads[0]!.payload).toEqual(payloads[1]!.payload)
  } finally {
    session.close()
  }
})

async function startRuntime(options: { events: InstrumentationEvent[]; maxPayloadBytes?: number }) {
  runtime = configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeSubscription: () => true,
    instrumentation: (event) => {
      options.events.push(event)
    },
    ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
  })
  runtime.register(PayloadReader)
  await runtime.install()
  return runtime
}

async function subscribe(options: { authorizationContext: string; payloads: string[] }) {
  const delivered: RealtimeEnvelope[] = []
  const session = runtime!.realtime.connect({
    authorizationContext: options.authorizationContext,
    send: (envelope) => {
      delivered.push(envelope)
    },
  })
  try {
    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: PayloadReader.actorType,
      actorId: "one",
      payloads: options.payloads,
    })
    return delivered.filter((envelope) => envelope.kind === "payload")
  } finally {
    session.close()
  }
}

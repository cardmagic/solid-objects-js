import { describe, expect, it, vi } from "vitest"
import {
  parseInvalidation,
  parseRealtimeEnvelope,
  SolidObjectsBrowserClient,
  type InvalidationEnvelope,
  type PayloadEnvelope,
} from "../src/browser/index.js"

describe("SolidObjectsBrowserClient", () => {
  it("sends subscriptions when the socket opens", () => {
    const socket = new FakeWebSocket()
    const client = new SolidObjectsBrowserClient({
      url: "wss://example.test/solid-objects",
      createWebSocket: () => socket as unknown as WebSocket,
      onInvalidation: () => {},
    })
    client.subscribe({ actorType: "Counter", actorId: "one", payloads: ["summary"] })

    client.connect()
    socket.open()

    expect(socket.sent).toEqual([
      JSON.stringify({
        version: 1,
        action: "subscribe",
        actorType: "Counter",
        actorId: "one",
        payloads: ["summary"],
      }),
    ])
  })

  it("rejects stale revisions and accepts a new actor incarnation", () => {
    const received: InvalidationEnvelope[] = []
    const client = new SolidObjectsBrowserClient({
      url: "wss://example.test/solid-objects",
      createWebSocket: () => new FakeWebSocket() as unknown as WebSocket,
      onInvalidation: (envelope) => received.push(envelope),
    })
    client.subscribe({ actorType: "Counter", actorId: "one" })

    client.receive(envelope({ instanceId: "first", revision: "2", count: 2 }))
    client.receive(envelope({ instanceId: "first", revision: "1", count: 1 }))
    client.receive(envelope({ instanceId: "second", revision: "1", count: 0 }))

    expect(received.map((value) => value.observables.count)).toEqual([2, 0])
  })

  it("reports malformed invalidations without delivering them", () => {
    const onInvalidation = vi.fn()
    const onError = vi.fn()
    const client = new SolidObjectsBrowserClient({
      url: "wss://example.test/solid-objects",
      onInvalidation,
      onError,
    })

    client.receive("not json")

    expect(onInvalidation).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })

  it("delivers each personalized payload once per revision", () => {
    const received: PayloadEnvelope[] = []
    const client = new SolidObjectsBrowserClient({
      url: "wss://example.test/solid-objects",
      onInvalidation: () => {},
      onPayload: (envelope) => received.push(envelope),
    })
    client.subscribe({
      actorType: "Counter",
      actorId: "one",
      payloads: ["summary"],
    })

    client.receive(payloadEnvelope({ instanceId: "first", revision: "2", count: 2 }))
    client.receive(payloadEnvelope({ instanceId: "first", revision: "2", count: 2 }))
    client.receive(payloadEnvelope({ instanceId: "second", revision: "1", count: 0 }))

    expect(received.map(({ payload }) => payload)).toEqual([{ count: 2 }, { count: 0 }])
    expect(Object.isFrozen(received[0]?.payload)).toBe(true)
  })

  it("replays a payload restored by a replacement subscription", () => {
    const received: PayloadEnvelope[] = []
    const client = new SolidObjectsBrowserClient({
      url: "wss://example.test/solid-objects",
      onInvalidation: () => {},
      onPayload: (envelope) => received.push(envelope),
    })
    const firstUnsubscribe = client.subscribe({
      actorType: "Counter",
      actorId: "one",
      payloads: ["summary"],
    })
    client.receive(payloadEnvelope({ instanceId: "first", revision: "2", count: 2 }))
    client.subscribe({ actorType: "Counter", actorId: "one" })
    client.subscribe({
      actorType: "Counter",
      actorId: "one",
      payloads: ["summary"],
    })
    firstUnsubscribe()
    client.receive(payloadEnvelope({ instanceId: "first", revision: "2", count: 2 }))

    expect(received).toHaveLength(2)
  })
})

describe("parseInvalidation", () => {
  it("validates the protocol envelope", () => {
    const parsed = parseInvalidation(
      envelope({
        instanceId: "instance",
        revision: "3",
        count: 3,
      }),
    )

    expect(parsed).toMatchObject({ revision: "3", observables: { count: 3 } })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.observables)).toBe(true)
  })

  it("rejects non-JSON observable values", () => {
    expect(() =>
      parseInvalidation({
        version: 1,
        actorType: "Counter",
        actorId: "one",
        instanceId: "instance",
        revision: "3",
        observables: { updatedAt: new Date() },
      }),
    ).toThrow("JSON-compatible")
  })
})

describe("parseRealtimeEnvelope", () => {
  it("validates personalized payload envelopes", () => {
    const parsed = parseRealtimeEnvelope(
      payloadEnvelope({ instanceId: "instance", revision: "3", count: 3 }),
    )

    expect(parsed).toMatchObject({
      kind: "payload",
      name: "summary",
      revision: "3",
      payload: { count: 3 },
    })
  })

  it("rejects unknown envelope kinds", () => {
    expect(() =>
      parseRealtimeEnvelope({
        version: 1,
        kind: "unknown",
        actorType: "Counter",
        actorId: "one",
        instanceId: "instance",
        revision: "3",
        observables: {},
      }),
    ).toThrow("invalid realtime envelope kind")
  })
})

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  sent: string[] = []

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }
}

function envelope(options: { instanceId: string; revision: string; count: number }): string {
  return JSON.stringify({
    version: 1,
    actorType: "Counter",
    actorId: "one",
    instanceId: options.instanceId,
    revision: options.revision,
    observables: { count: options.count },
  })
}

function payloadEnvelope(options: { instanceId: string; revision: string; count: number }): string {
  return JSON.stringify({
    version: 1,
    kind: "payload",
    actorType: "Counter",
    actorId: "one",
    instanceId: options.instanceId,
    revision: options.revision,
    name: "summary",
    payload: { count: options.count },
  })
}

import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { createRuntime, durableObjects } from "../../src/cloudflare/index.js"
import { Counter, revokedSessions } from "./worker.js"
import { SolidObjectsBrowserClient } from "../../src/browser/index.js"

const sockets: WebSocket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close()
})

async function connect() {
  const sessionName = crypto.randomUUID()
  const stub = env.SESSIONS.getByName(sessionName)
  const response = await stub.fetch("https://solid-objects.internal/session", {
    headers: {
      Upgrade: "websocket",
      "X-Solid-Session-Name": sessionName,
      "X-Solid-Session-Id": "test-session",
      "X-Solid-Session-Expiry": String(Date.now() + 60_000),
    },
  })
  const socket = response.webSocket!
  socket.accept()
  sockets.push(socket)
  const messages: Record<string, unknown>[] = []
  socket.addEventListener("message", (event: MessageEvent) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
  })
  return { socket, messages, stub }
}

describe("Cloudflare realtime", () => {
  it("drops duplicate revisions and events from a destroyed incarnation", async () => {
    const { socket, messages, stub } = await connect()
    const runtime = createRuntime({ backend: durableObjects({ namespace: env.ACTORS }) })
    const reference = runtime.ref(Counter, "revision-fence")
    socket.send(
      JSON.stringify({
        version: 1,
        action: "subscribe",
        actorType: "Counter",
        actorId: "revision-fence",
      }),
    )
    await expect.poll(() => messages.length).toBe(1)
    await reference.with({ authorizationContext: "allowed" }).increment()
    await expect.poll(() => messages.length).toBe(2)
    const old = messages[1]!
    await reference.destroy({ authorizationContext: "allowed" })
    await reference.with({ authorizationContext: "allowed" }).increment()
    await expect.poll(() => messages.length).toBe(3)
    const subscriptionId = await runInDurableObject(
      stub,
      (_object, state) =>
        state.storage.sql.exec<{ id: string }>("SELECT id FROM subscriptions").one().id,
    )
    await stub.publish({ subscriptionId, event: old as import("../../src/core.js").JsonObject })
    await stub.publish({
      subscriptionId,
      event: messages[2] as import("../../src/core.js").JsonObject,
    })
    expect(messages).toHaveLength(3)
    expect(messages[2]!.instanceId).not.toBe(old.instanceId)
  })

  it("expires idle sessions through their alarm", async () => {
    const { stub } = await connect()
    await runInDurableObject(stub, (_object, state) => {
      const session = state.storage.kv.get<Record<string, unknown>>("session")!
      state.storage.kv.put("session", { ...session, expiresAt: Date.now() - 1 })
    })
    await runDurableObjectAlarm(stub)
    const closed = await runInDurableObject(
      stub,
      (_object, state) => state.storage.kv.get<{ closed: boolean }>("session")?.closed,
    )
    expect(closed).toBe(true)
  })

  it("uses the existing browser client and isolates failed or denied payloads", async () => {
    const { socket } = await connect()
    const invalidations: unknown[] = []
    const payloads: { name: string }[] = []
    const client = new SolidObjectsBrowserClient({
      url: "wss://example.invalid/events",
      createWebSocket: () => socket,
      onInvalidation: (envelope) => invalidations.push(envelope),
      onPayload: (envelope) => payloads.push(envelope),
    })
    client.connect()
    client.subscribe({
      actorType: "Counter",
      actorId: "payloads",
      payloads: ["personal", "broken", "denied"],
    })
    await expect.poll(() => payloads.length).toBe(1)
    expect(payloads[0]).toMatchObject({
      name: "personal",
      payload: { count: 0, authorization: "allowed" },
    })
    expect(invalidations).toHaveLength(1)
    client.close()
  })

  it("reauthorizes an existing connection before delivering a new revision", async () => {
    const { socket, messages, stub } = await connect()
    socket.send(
      JSON.stringify({ version: 1, action: "subscribe", actorType: "Counter", actorId: "revoked" }),
    )
    await expect.poll(() => messages.length).toBe(1)
    revokedSessions.add("test-session")
    try {
      await createRuntime({ backend: durableObjects({ namespace: env.ACTORS }) })
        .ref(Counter, "revoked")
        .with({ authorizationContext: "allowed" })
        .increment()
      await expect
        .poll(() =>
          runInDurableObject(
            stub,
            (_object, state) => state.storage.kv.get<{ closed: boolean }>("session")?.closed,
          ),
        )
        .toBe(true)
      expect(messages).toHaveLength(1)
    } finally {
      revokedSessions.delete("test-session")
    }
  })

  it("multiplexes actors and resumes a hibernating connection", async () => {
    const { socket, messages, stub } = await connect()
    for (const actorId of ["first", "second"])
      socket.send(
        JSON.stringify({ version: 1, action: "subscribe", actorType: "Counter", actorId }),
      )
    await expect.poll(() => messages.length).toBe(2)
    expect(messages.map((message) => message.actorId).sort()).toEqual(["first", "second"])
    await evictDurableObject(stub)
    const runtime = createRuntime({
      backend: durableObjects({ namespace: env.ACTORS, sessions: env.SESSIONS }),
    })
    await runtime.ref(Counter, "first").with({ authorizationContext: "allowed" }).increment()
    const actor = env.ACTORS.getByName(JSON.stringify(["Counter", "first"]))
    await runDurableObjectAlarm(actor)
    await expect.poll(() => messages.length).toBe(3)
    expect(messages[2]).toMatchObject({ actorId: "first", observables: { count: 1 } })
  })

  it("rejects expired or unauthenticated sessions", async () => {
    const name = crypto.randomUUID()
    const response = await env.SESSIONS.getByName(name).fetch(
      "https://solid-objects.internal/session",
      {
        headers: {
          Upgrade: "websocket",
          "X-Solid-Session-Name": name,
          "X-Solid-Session-Id": "invalid",
          "X-Solid-Session-Expiry": String(Date.now() + 60_000),
        },
      },
    )
    expect(response.status).toBe(401)
  })

  it("cleans up actor subscriptions after disconnect", async () => {
    const { socket, messages, stub } = await connect()
    socket.send(
      JSON.stringify({ version: 1, action: "subscribe", actorType: "Counter", actorId: "cleanup" }),
    )
    await expect.poll(() => messages.length).toBe(1)
    socket.close()
    await expect
      .poll(async () =>
        runInDurableObject(
          stub,
          (_object, state) => state.storage.kv.get<{ closed: boolean }>("session")?.closed,
        ),
      )
      .toBe(true)
    await runDurableObjectAlarm(stub)
    const actor = env.ACTORS.getByName(JSON.stringify(["Counter", "cleanup"]))
    await expect
      .poll(() =>
        runInDurableObject(
          actor,
          (_object, state) =>
            state.storage.sql
              .exec<{ count: number }>("SELECT COUNT(*) AS count FROM subscriptions")
              .one().count,
        ),
      )
      .toBe(0)
  })
})

import { expect, test } from "@playwright/test"
import { WebSocketServer, type WebSocket } from "ws"

test("replays subscriptions and fences realtime envelopes", async ({ page }) => {
  const server = new WebSocketServer({ port: 0 })
  const address = server.address()
  if (typeof address === "string" || address === null) throw new Error("WebSocket port unavailable")
  const connections: WebSocket[] = []
  const messages: string[] = []
  server.on("connection", (socket) => {
    connections.push(socket)
    socket.on("message", (value) => messages.push(value.toString()))
  })
  await page.goto("/")
  await page.evaluate(async (url) => {
    const modulePath = "/browser/index.js"
    const { SolidObjectsBrowserClient } = (await import(
      modulePath
    )) as typeof import("../../src/browser/index.js")
    const state = {
      invalidations: [] as unknown[],
      payloads: [] as unknown[],
      client: undefined as InstanceType<typeof SolidObjectsBrowserClient> | undefined,
    }
    state.client = new SolidObjectsBrowserClient({
      url,
      onInvalidation: (envelope) => state.invalidations.push(envelope),
      onPayload: (envelope) => state.payloads.push(envelope),
    })
    state.client.subscribe({ actorType: "Counter", actorId: "one", payloads: ["summary"] })
    state.client.connect()
    Object.assign(globalThis, { realtimeState: state })
  }, `ws://127.0.0.1:${address.port}`)
  await expect.poll(() => messages.length).toBe(1)
  expect(JSON.parse(messages[0]!)).toMatchObject({
    action: "subscribe",
    actorType: "Counter",
    actorId: "one",
    payloads: ["summary"],
  })

  connections[0]!.send(invalidation({ instanceId: "first", revision: "2", count: 2 }))
  connections[0]!.send(invalidation({ instanceId: "first", revision: "1", count: 1 }))
  connections[0]!.send(invalidation({ instanceId: "second", revision: "1", count: 0 }))
  connections[0]!.send(payload({ instanceId: "second", revision: "1", count: 0 }))
  connections[0]!.send(payload({ instanceId: "second", revision: "1", count: 0 }))
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          globalThis as typeof globalThis & {
            realtimeState: { invalidations: unknown[]; payloads: unknown[] }
          }
        ).realtimeState
        return [state.invalidations.length, state.payloads.length]
      }),
    )
    .toEqual([2, 1])

  await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        realtimeState: { client: { close(): void; connect(): void } }
      }
    ).realtimeState
    state.client.close()
    state.client.connect()
  })
  await expect.poll(() => connections.length).toBe(2)
  await expect.poll(() => messages.length).toBe(2)
  expect(JSON.parse(messages[1]!)).toMatchObject({ action: "subscribe", actorId: "one" })
  await server.close()
})

test("batches component refreshes and aborts superseded work", async ({ page }) => {
  await page.goto("/")
  const result = await page.evaluate(async () => {
    const modulePath = "/browser/index.js"
    const { SolidObjectsComponentRegistry } = (await import(
      modulePath
    )) as typeof import("../../src/browser/index.js")
    const requests: Array<{
      revision: string
      targets: string[]
      aborted: boolean
    }> = []
    const resolutions: Array<(value: Array<{ target: string; rendered: string }>) => void> = []
    const applied: string[] = []
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh: (request) => {
        const recorded = {
          revision: request.revision,
          targets: request.components.map(({ target }) => target),
          aborted: request.signal.aborted,
        }
        requests.push(recorded)
        request.signal.addEventListener("abort", () => {
          recorded.aborted = true
        })
        return new Promise((resolve) => resolutions.push(resolve))
      },
      apply: ({ rendered }) => applied.push(rendered),
    })
    for (const [target, observes] of [
      ["player", "playerOne"],
      ["controls", "controls"],
    ] as const) {
      registry.register({
        actorType: "GameRoom",
        actorId: "table-1",
        target,
        name: target,
        observes: [observes],
        batch: "playmat",
      })
    }
    const invalidate = (
      revision: string,
      observables: Record<string, string | number | boolean | null>,
    ) =>
      registry.invalidate({
        version: 1,
        kind: "invalidation",
        actorType: "GameRoom",
        actorId: "table-1",
        instanceId: "instance-1",
        revision,
        observables,
      })

    invalidate("1", { playerOne: 1 })
    invalidate("1", { controls: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    invalidate("2", { playerOne: 2 })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    resolutions[0]?.([
      { target: "player", rendered: "old player" },
      { target: "controls", rendered: "old controls" },
    ])
    resolutions[1]?.([{ target: "player", rendered: "new player" }])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    registry.close()
    return { requests, applied }
  })

  expect(result.requests).toEqual([
    { revision: "1", targets: ["player", "controls"], aborted: true },
    { revision: "2", targets: ["player"], aborted: false },
  ])
  expect(result.applied).toEqual(["new player"])
})

function invalidation(options: { instanceId: string; revision: string; count: number }): string {
  return JSON.stringify({
    version: 1,
    kind: "invalidation",
    actorType: "Counter",
    actorId: "one",
    instanceId: options.instanceId,
    revision: options.revision,
    observables: { count: options.count },
  })
}

function payload(options: { instanceId: string; revision: string; count: number }): string {
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

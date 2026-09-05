import {
  createDurableObjectsHost,
  createDurableObjectsSessionHost,
  createRuntime,
  durableObjects,
  type CloudflareConfiguration,
} from "solid-objects/cloudflare"
import { Counter } from "./counter.js"
import type { JsonValue } from "solid-objects/core"

function backend(environment: Env) {
  return durableObjects({ namespace: environment.ACTORS, sessions: environment.SESSIONS })
}

function publicCounter(input: {
  actorType: string
  actorId: string
  authorizationContext: JsonValue
}): boolean {
  return (
    input.actorType === "Counter" &&
    input.actorId === "public-demo" &&
    input.authorizationContext === "public-demo"
  )
}

export class Actors extends createDurableObjectsHost<Env>({
  actors: [Counter],
  configure: (environment): CloudflareConfiguration => ({
    backend: backend(environment),
    authorizeMessage: publicCounter,
    authorizeQuery: publicCounter,
    authorizeSubscription: publicCounter,
  }),
}) {}

export class Sessions extends createDurableObjectsSessionHost<Env>({
  backend,
  resolveAuthorizationContext: ({ sessionId }) =>
    sessionId === "public-demo" ? "public-demo" : null,
}) {}

export default {
  async fetch(request: Request, environment: Env): Promise<Response> {
    const url = new URL(request.url)
    const runtime = createRuntime({ backend: backend(environment) })
    const counter = runtime
      .ref(Counter, "public-demo")
      .with({ authorizationContext: "public-demo" })
    const isWebSocketRequest =
      url.pathname === "/events" && request.headers.get("Upgrade") === "websocket"
    const origin = request.headers.get("Origin")
    if (isWebSocketRequest && origin !== null && origin !== url.origin)
      return new Response("Forbidden", { status: 403 })
    if (isWebSocketRequest)
      return runtime.openWebSocket({
        sessionId: "public-demo",
        expiresAt: new Date(Date.now() + 3_600_000),
      })
    if (request.method === "GET" && url.pathname === "/counter")
      return Response.json({ count: await counter.count })
    if (request.method === "POST" && url.pathname === "/increment")
      return Response.json({ count: await counter.increment() })
    if (request.method === "POST" && url.pathname === "/increment-later") {
      await counter.incrementLater()
      return new Response(null, { status: 202 })
    }
    return new Response("GET /counter; POST /increment; POST /increment-later; WebSocket /events", {
      status: url.pathname === "/" ? 200 : 404,
    })
  },
} satisfies ExportedHandler<Env>

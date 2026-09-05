import {
  createDurableObjectsHost,
  createDurableObjectsSessionHost,
  createRuntime,
  durableObjects,
  type CloudflareConfiguration,
} from "solid-objects/cloudflare"
import { ShoppingCart } from "./shopping-cart.js"

function backend(environment: Env) {
  return durableObjects({ namespace: environment.ACTORS, sessions: environment.SESSIONS })
}

function publicCart(input: {
  actorType: string
  actorId: string
  authorizationContext: unknown
}): boolean {
  return (
    input.actorType === "ShoppingCart" &&
    input.actorId === "demo-cart" &&
    input.authorizationContext === "public-demo"
  )
}

export class Actors extends createDurableObjectsHost<Env>({
  actors: [ShoppingCart],
  configure: (environment): CloudflareConfiguration => ({
    backend: backend(environment),
    authorizeMessage: publicCart,
    authorizeQuery: publicCart,
    authorizeSubscription: publicCart,
  }),
}) {}

export class Sessions extends createDurableObjectsSessionHost<Env>({
  backend,
  resolveAuthorizationContext: ({ sessionId }) =>
    sessionId === "demo-cart" ? "public-demo" : null,
}) {}

export default {
  async fetch(request: Request, environment: Env): Promise<Response> {
    const url = new URL(request.url)
    const runtime = createRuntime({ backend: backend(environment) })
    const cartReference = runtime.ref(ShoppingCart, "demo-cart")
    const cart = cartReference.with({ authorizationContext: "public-demo" })
    const isWebSocketRequest =
      url.pathname === "/events" && request.headers.get("Upgrade") === "websocket"
    const origin = request.headers.get("Origin")
    if (isWebSocketRequest && origin !== null && origin !== url.origin)
      return new Response("Forbidden", { status: 403 })
    if (isWebSocketRequest)
      return runtime.openWebSocket({
        sessionId: "demo-cart",
        expiresAt: new Date(Date.now() + 3_600_000),
      })
    if (request.method === "GET" && url.pathname === "/cart")
      return Response.json(
        await runtime.snapshot(cartReference, { authorizationContext: "public-demo" }),
      )
    if (request.method === "POST" && url.pathname === "/cart/items") {
      const item = (await request.json()) as {
        sku: string
        name: string
        priceCents: number
        quantity?: number
      }
      return Response.json({ totalCents: await cart.addItem(item) })
    }
    if (request.method === "POST" && url.pathname === "/cart/remove") {
      const item = (await request.json()) as { sku: string }
      await cart.removeItem(item)
      return new Response(null, { status: 204 })
    }
    if (request.method === "POST" && url.pathname === "/cart/clear-later") {
      await cart.clearLater()
      return new Response(null, { status: 202 })
    }
    return new Response(
      "GET /cart; POST /cart/items; POST /cart/remove; POST /cart/clear-later; WebSocket /events",
      {
        status: url.pathname === "/" ? 200 : 404,
      },
    )
  },
} satisfies ExportedHandler<Env>

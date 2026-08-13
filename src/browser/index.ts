import type { JsonObject } from "../types.js"

export interface ActorSubscription {
  actorType: string
  actorId: string
}

export interface InvalidationEnvelope extends ActorSubscription {
  version: 1
  instanceId: string
  revision: string
  observables: JsonObject
}

export interface BrowserClientOptions {
  url: string | URL
  createWebSocket?: (url: string | URL) => WebSocket
  onInvalidation(envelope: InvalidationEnvelope): void
  onError?: (error: Error) => void
}

export class SolidObjectsBrowserClient {
  readonly #options: BrowserClientOptions
  readonly #subscriptions = new Map<string, ActorSubscription>()
  readonly #revisions = new Map<string, { instanceId: string; revision: bigint }>()
  #socket: WebSocket | undefined

  constructor(options: BrowserClientOptions) {
    this.#options = options
  }

  connect(): void {
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) return
    const socket =
      this.#options.createWebSocket?.(this.#options.url) ?? new WebSocket(this.#options.url)
    socket.addEventListener("open", () => {
      for (const subscription of this.#subscriptions.values()) this.sendSubscription(subscription)
    })
    socket.addEventListener("message", (event) => this.receive(event.data))
    socket.addEventListener("error", () => this.report(new Error("Solid Objects WebSocket failed")))
    this.#socket = socket
  }

  subscribe(subscription: ActorSubscription): () => void {
    const normalized = normalizeSubscription(subscription)
    const key = subscriptionKey(normalized)
    this.#subscriptions.set(key, normalized)
    if (this.#socket?.readyState === WebSocket.OPEN) this.sendSubscription(normalized)
    return () => {
      if (!this.#subscriptions.delete(key)) return
      this.#revisions.delete(key)
      if (this.#socket?.readyState === WebSocket.OPEN) {
        this.#socket.send(JSON.stringify({ version: 1, action: "unsubscribe", ...normalized }))
      }
    }
  }

  close(code = 1000, reason = "client closed"): void {
    this.#socket?.close(code, reason)
    this.#socket = undefined
  }

  receive(value: unknown): void {
    try {
      const envelope = parseInvalidation(value)
      const key = subscriptionKey(envelope)
      if (!this.#subscriptions.has(key)) return
      if (!this.acceptRevision(key, envelope)) return
      this.#options.onInvalidation(envelope)
    } catch (error) {
      this.report(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private acceptRevision(key: string, envelope: InvalidationEnvelope): boolean {
    const revision = BigInt(envelope.revision)
    const current = this.#revisions.get(key)
    if (current?.instanceId === envelope.instanceId && revision <= current.revision) return false
    this.#revisions.set(key, { instanceId: envelope.instanceId, revision })
    return true
  }

  private sendSubscription(subscription: ActorSubscription): void {
    this.#socket?.send(JSON.stringify({ version: 1, action: "subscribe", ...subscription }))
  }

  private report(error: Error): void {
    this.#options.onError?.(error)
  }
}

export function parseInvalidation(value: unknown): InvalidationEnvelope {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value
  if (!isRecord(parsed) || parsed.version !== 1) throw new TypeError("invalid invalidation version")
  const actorType = requiredString(parsed.actorType, "actorType")
  const actorId = requiredString(parsed.actorId, "actorId")
  const instanceId = requiredString(parsed.instanceId, "instanceId")
  const revision = requiredString(parsed.revision, "revision")
  if (!/^(0|[1-9][0-9]*)$/.test(revision))
    throw new TypeError("invalidation revision must be an integer string")
  if (!isRecord(parsed.observables))
    throw new TypeError("invalidation observables must be an object")
  return {
    version: 1,
    actorType,
    actorId,
    instanceId,
    revision,
    observables: normalizeJsonObject(parsed.observables),
  }
}

function normalizeSubscription(subscription: ActorSubscription): ActorSubscription {
  return {
    actorType: requiredString(subscription.actorType, "actorType"),
    actorId: requiredString(subscription.actorId, "actorId"),
  }
}

function subscriptionKey(subscription: ActorSubscription): string {
  return JSON.stringify([subscription.actorType, subscription.actorId])
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function normalizeJsonObject(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeJsonValue({ value: item, depth: 1 }),
    ]),
  )
}

function normalizeJsonValue(options: { value: unknown; depth: number }): JsonObject[string] {
  const { value, depth } = options
  if (depth > 100) throw new TypeError("invalidation observables are nested too deeply")
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue({ value: item, depth: depth + 1 }))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeJsonValue({ value: item, depth: depth + 1 }),
      ]),
    )
  }
  throw new TypeError("invalidation observables must contain only JSON-compatible values")
}

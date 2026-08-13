import type { DeepReadonly, JsonObject, JsonValue } from "../types.js"

export {
  SolidObjectsComponentRegistry,
  type ComponentApplication,
  type ComponentRefreshFailure,
  type ComponentRefreshRequest,
  type ComponentRefreshResult,
  type ComponentRefreshStrategy,
  type ComponentRegistration,
  type ComponentRegistryOptions,
  type RegisteredComponent,
} from "./components.js"

const MAXIMUM_PAYLOADS_PER_SUBSCRIPTION = 50

interface ActorIdentity {
  actorType: string
  actorId: string
}

export interface ActorSubscription extends ActorIdentity {
  payloads?: readonly string[]
}

export interface InvalidationEnvelope extends ActorIdentity {
  version: 1
  kind: "invalidation"
  instanceId: string
  revision: string
  observables: DeepReadonly<JsonObject>
}

export interface PayloadEnvelope extends ActorIdentity {
  version: 1
  kind: "payload"
  instanceId: string
  revision: string
  name: string
  payload: DeepReadonly<JsonObject | JsonValue[]>
}

export type RealtimeEnvelope = InvalidationEnvelope | PayloadEnvelope

export interface BrowserClientOptions {
  url: string | URL
  createWebSocket?: (url: string | URL) => WebSocket
  onInvalidation(envelope: InvalidationEnvelope): void
  onPayload?: (envelope: PayloadEnvelope) => void
  onError?: (error: Error) => void
}

export class SolidObjectsBrowserClient {
  readonly #options: BrowserClientOptions
  readonly #subscriptions = new Map<string, ActorSubscription>()
  readonly #revisions = new Map<string, Map<string, { instanceId: string; revision: bigint }>>()
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
    const previous = this.#subscriptions.get(key)
    const revisions = this.#revisions.get(key)
    for (const payload of normalized.payloads ?? []) {
      if (!previous?.payloads?.includes(payload)) revisions?.delete(`payload:${payload}`)
    }
    this.#subscriptions.set(key, normalized)
    if (this.#socket?.readyState === WebSocket.OPEN) this.sendSubscription(normalized)
    return () => {
      if (this.#subscriptions.get(key) !== normalized) return
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
      const envelope = parseRealtimeEnvelope(value)
      const key = subscriptionKey(envelope)
      const subscription = this.#subscriptions.get(key)
      if (!subscription) return
      if (envelope.kind === "payload" && !subscription.payloads?.includes(envelope.name)) return
      if (!this.acceptRevision(key, envelope)) return
      if (envelope.kind === "payload") {
        this.#options.onPayload?.(envelope)
        return
      }
      this.#options.onInvalidation(envelope)
    } catch (error) {
      this.report(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private acceptRevision(key: string, envelope: RealtimeEnvelope): boolean {
    const revision = BigInt(envelope.revision)
    const channel = envelope.kind === "payload" ? `payload:${envelope.name}` : "invalidation"
    const revisions = this.#revisions.get(key) ?? new Map()
    const current = revisions.get(channel)
    if (current?.instanceId === envelope.instanceId && revision <= current.revision) return false
    revisions.set(channel, { instanceId: envelope.instanceId, revision })
    this.#revisions.set(key, revisions)
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
  const revision = requiredRevision(parsed.revision)
  if (!isRecord(parsed.observables))
    throw new TypeError("invalidation observables must be an object")
  return Object.freeze({
    version: 1,
    kind: "invalidation",
    actorType,
    actorId,
    instanceId,
    revision,
    observables: normalizeJsonObject(parsed.observables),
  })
}

export function parseRealtimeEnvelope(value: unknown): RealtimeEnvelope {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value
  if (isRecord(parsed) && parsed.kind === "payload") return parsePayload(parsed)
  if (isRecord(parsed) && parsed.kind !== undefined && parsed.kind !== "invalidation") {
    throw new TypeError("invalid realtime envelope kind")
  }
  return parseInvalidation(parsed)
}

function normalizeSubscription(subscription: ActorSubscription): ActorSubscription {
  const payloads = normalizePayloadNames(subscription.payloads)
  return Object.freeze({
    actorType: requiredString(subscription.actorType, "actorType"),
    actorId: requiredString(subscription.actorId, "actorId"),
    ...(payloads.length === 0 ? {} : { payloads }),
  })
}

function subscriptionKey(subscription: ActorIdentity): string {
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

function normalizeJsonObject(value: Record<string, unknown>): DeepReadonly<JsonObject> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeJsonValue({ value: item, depth: 1 }),
      ]),
    ),
  )
}

function parsePayload(parsed: Record<string, unknown>): PayloadEnvelope {
  if (parsed.version !== 1) throw new TypeError("invalid payload version")
  const actorType = requiredString(parsed.actorType, "actorType")
  const actorId = requiredString(parsed.actorId, "actorId")
  const instanceId = requiredString(parsed.instanceId, "instanceId")
  const revision = requiredRevision(parsed.revision)
  const name = requiredString(parsed.name, "name")
  if (!isRecord(parsed.payload) && !Array.isArray(parsed.payload)) {
    throw new TypeError("payload must be a JSON object or array")
  }
  const payload = normalizeJsonValue({ value: parsed.payload, depth: 0 })
  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new TypeError("payload must be a JSON object or array")
  }
  return Object.freeze({
    version: 1,
    kind: "payload",
    actorType,
    actorId,
    instanceId,
    revision,
    name,
    payload,
  })
}

function requiredRevision(value: unknown): string {
  const revision = requiredString(value, "revision")
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) {
    throw new TypeError("realtime revision must be an integer string")
  }
  return revision
}

function normalizePayloadNames(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return Object.freeze([])
  if (!Array.isArray(values) || values.length > MAXIMUM_PAYLOADS_PER_SUBSCRIPTION) {
    throw new TypeError(
      `payloads must be an array of at most ${MAXIMUM_PAYLOADS_PER_SUBSCRIPTION} names`,
    )
  }
  const names = values.map((value) => requiredString(value, "payload name"))
  return Object.freeze([...new Set(names)])
}

function normalizeJsonValue(options: { value: unknown; depth: number }): DeepReadonly<JsonValue> {
  const { value, depth } = options
  if (depth > 100) throw new TypeError("realtime value is nested too deeply")
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => normalizeJsonValue({ value: item, depth: depth + 1 })))
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          normalizeJsonValue({ value: item, depth: depth + 1 }),
        ]),
      ),
    )
  }
  throw new TypeError("realtime values must contain only JSON-compatible values")
}

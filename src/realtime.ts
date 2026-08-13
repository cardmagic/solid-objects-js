import type { InvalidationEnvelope, RealtimeEnvelope } from "./browser/index.js"
import type { BroadcastEvent } from "./configuration.js"
import type { SolidObjectsRuntime } from "./runtime.js"

const MAXIMUM_PAYLOADS_PER_SUBSCRIPTION = 50

export interface SubscriptionRequest {
  readonly version: 1
  readonly action: "subscribe" | "unsubscribe"
  readonly actorType: string
  readonly actorId: string
  readonly payloads?: readonly string[]
}

export interface RealtimeConnectionOptions<AuthorizationContext = unknown> {
  authorizationContext: AuthorizationContext
  send(envelope: RealtimeEnvelope): void | Promise<void>
}

export interface RealtimeSession {
  readonly closed: boolean
  receive(value: unknown): Promise<void>
  close(): void
}

export class RealtimeManager {
  private readonly subscriptions = new Map<string, Set<ManagedRealtimeSession>>()

  constructor(private readonly runtime: SolidObjectsRuntime) {}

  connect<AuthorizationContext>(
    options: RealtimeConnectionOptions<AuthorizationContext>,
  ): RealtimeSession {
    let session: ManagedRealtimeSession
    session = new ManagedRealtimeSession(options, {
      receive: (value) => this.receive(session, value),
      disconnect: () => this.removeSession(session),
    })
    return session
  }

  async publish(event: BroadcastEvent): Promise<void> {
    const key = subscriptionKey(event)
    const sessions = [...(this.subscriptions.get(key) ?? [])]
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await session.deliver(invalidationEnvelope(event))
          const payloads = await this.runtime.subscriptionPayloads({
            actorType: event.actorType,
            actorId: event.actorId,
            payloadNames: session.payloadNames(event),
            authorizationContext: session.authorizationContext,
          })
          for (const payload of payloads) await session.deliver(payload)
        } catch (error) {
          this.remove(session, event)
          this.runtime.emitInstrumentation("subscription.delivery_failed", {
            actorType: event.actorType,
            actorId: event.actorId,
            errorName: error instanceof Error ? error.name : "Error",
          })
        }
      }),
    )
  }

  close(): void {
    const sessions = new Set([...this.subscriptions.values()].flatMap((entries) => [...entries]))
    for (const session of sessions) session.close()
    this.subscriptions.clear()
  }

  private async receive(session: ManagedRealtimeSession, value: unknown): Promise<void> {
    if (session.closed) throw new TypeError("realtime connection is closed")
    const request = parseSubscriptionRequest(value)
    if (request.action === "unsubscribe") {
      this.remove(session, request)
      return
    }

    try {
      const snapshot = await this.runtime.subscriptionSnapshot({
        actorType: request.actorType,
        actorId: request.actorId,
        authorizationContext: session.authorizationContext,
        onAuthorized: () => {
          if (!session.closed) this.add(session, request)
        },
      })
      if (session.closed) return
      const payloads = await this.runtime.subscriptionPayloads({
        actorType: request.actorType,
        actorId: request.actorId,
        payloadNames: request.payloads ?? [],
        authorizationContext: session.authorizationContext,
      })
      await session.deliver(invalidationEnvelope(snapshot))
      for (const payload of payloads) await session.deliver(payload)
    } catch (error) {
      this.remove(session, request)
      throw error
    }
  }

  private removeSession(session: ManagedRealtimeSession): void {
    for (const [key, sessions] of this.subscriptions) {
      sessions.delete(session)
      if (sessions.size === 0) this.subscriptions.delete(key)
    }
  }

  private add(session: ManagedRealtimeSession, subscription: SubscriptionIdentity): void {
    const key = subscriptionKey(subscription)
    const sessions = this.subscriptions.get(key) ?? new Set()
    sessions.add(session)
    this.subscriptions.set(key, sessions)
    session.add(subscription)
  }

  private remove(session: ManagedRealtimeSession, subscription: SubscriptionIdentity): void {
    const key = subscriptionKey(subscription)
    const sessions = this.subscriptions.get(key)
    if (!sessions) return
    sessions.delete(session)
    if (sessions.size === 0) this.subscriptions.delete(key)
    session.remove(subscription)
  }
}

class ManagedRealtimeSession implements RealtimeSession {
  readonly authorizationContext: unknown
  #closed = false
  #delivery = Promise.resolve()
  #requests = Promise.resolve()
  readonly #subscriptions = new Map<string, ReadonlySet<string>>()
  readonly #revisions = new Map<string, Map<string, { instanceId: string; revision: bigint }>>()

  constructor(
    private readonly options: RealtimeConnectionOptions,
    private readonly lifecycle: {
      receive(value: unknown): Promise<void>
      disconnect(): void
    },
  ) {
    this.authorizationContext = options.authorizationContext
  }

  get closed(): boolean {
    return this.#closed
  }

  receive(value: unknown): Promise<void> {
    const request = this.#requests.catch(() => undefined).then(() => this.lifecycle.receive(value))
    this.#requests = request
    return request
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#subscriptions.clear()
    this.#revisions.clear()
    this.lifecycle.disconnect()
  }

  deliver(envelope: RealtimeEnvelope): Promise<void> {
    const delivery = this.#delivery
      .catch(() => undefined)
      .then(() => {
        if (this.#closed || !this.accepts(envelope) || !this.accept(envelope)) {
          return
        }
        return this.options.send(envelope)
      })
      .then(() => undefined)
    this.#delivery = delivery
    return delivery
  }

  remove(subscription: SubscriptionIdentity): void {
    const key = subscriptionKey(subscription)
    this.#subscriptions.delete(key)
    this.#revisions.delete(key)
  }

  add(subscription: SubscriptionIdentity): void {
    const key = subscriptionKey(subscription)
    const previous = this.#subscriptions.get(key)
    const revisions = this.#revisions.get(key)
    for (const payload of subscription.payloads ?? []) {
      if (!previous?.has(payload)) revisions?.delete(`payload:${payload}`)
    }
    this.#subscriptions.set(key, new Set(subscription.payloads ?? []))
  }

  payloadNames(subscription: SubscriptionIdentity): readonly string[] {
    return [...(this.#subscriptions.get(subscriptionKey(subscription)) ?? [])]
  }

  private accepts(envelope: RealtimeEnvelope): boolean {
    const key = subscriptionKey(envelope)
    const payloadNames = this.#subscriptions.get(key)
    if (!payloadNames) return false
    if (envelope.kind === "payload" && !payloadNames.has(envelope.name)) return false
    return true
  }

  private accept(envelope: RealtimeEnvelope): boolean {
    const key = subscriptionKey(envelope)
    const revision = BigInt(envelope.revision)
    const channel = envelope.kind === "payload" ? `payload:${envelope.name}` : "invalidation"
    const revisions = this.#revisions.get(key) ?? new Map()
    const current = revisions.get(channel)
    if (current?.instanceId === envelope.instanceId && revision <= current.revision) return false
    revisions.set(channel, { instanceId: envelope.instanceId, revision })
    this.#revisions.set(key, revisions)
    return true
  }
}

export function parseSubscriptionRequest(value: unknown): SubscriptionRequest {
  const parsed = parseValue(value)
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new TypeError("invalid subscription protocol version")
  }
  if (parsed.action !== "subscribe" && parsed.action !== "unsubscribe") {
    throw new TypeError("invalid subscription action")
  }
  return Object.freeze({
    version: 1,
    action: parsed.action,
    actorType: requiredString(parsed.actorType, "actorType"),
    actorId: requiredString(parsed.actorId, "actorId"),
    ...(parsed.payloads === undefined ? {} : { payloads: parsePayloadNames(parsed.payloads) }),
  })
}

interface SubscriptionIdentity {
  actorType: string
  actorId: string
  payloads?: readonly string[]
}

function parseValue(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown
  if (value instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(value)) as unknown
  return value
}

function subscriptionKey(subscription: SubscriptionIdentity): string {
  return JSON.stringify([subscription.actorType, subscription.actorId])
}

function invalidationEnvelope(event: BroadcastEvent): InvalidationEnvelope {
  return Object.freeze({ version: 1, kind: "invalidation", ...event })
}

function parsePayloadNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_PAYLOADS_PER_SUBSCRIPTION) {
    throw new TypeError(
      `payloads must be an array of at most ${MAXIMUM_PAYLOADS_PER_SUBSCRIPTION} names`,
    )
  }
  const names = value.map((name) => requiredString(name, "payload name"))
  return Object.freeze([...new Set(names)])
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

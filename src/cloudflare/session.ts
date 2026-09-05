import { DurableObject } from "cloudflare:workers"
import { Unauthorized } from "../errors.js"
import { parseSubscriptionRequest } from "../realtime.js"
import { jsonObject, normalizeJson, utf8ByteLength } from "../serialization.js"
import type { JsonObject, JsonValue } from "../types.js"
import {
  actorName,
  callHost,
  type ActorIdentity,
  type DurableObjectsBackend,
  type SessionHost,
} from "./protocol.js"

interface SessionRecord {
  sessionName: string
  sessionId: string
  expiresAt: number
  closed: boolean
}

interface SessionSubscription extends ActorIdentity {
  id: string
  payloads: string[]
  status: "registering" | "active" | "removing"
  retryAt: number
  incarnationOrder: string
}

export function createDurableObjectsSessionHost<Environment>(options: {
  backend: (environment: Environment) => DurableObjectsBackend
  resolveAuthorizationContext: (input: {
    sessionId: string
    environment: Environment
  }) => JsonValue | null | Promise<JsonValue | null>
  maxSubscriptions?: number
}): new (
  context: DurableObjectState,
  environment: Environment,
) => DurableObject<Environment> & Pick<SessionHost, "publish"> {
  const maximum = options.maxSubscriptions ?? 100
  if (!Number.isSafeInteger(maximum) || maximum <= 0)
    throw new TypeError("maxSubscriptions must be a positive safe integer")
  return class SolidObjectsSessionHost extends DurableObject<Environment> {
    #receiving: Promise<void> = Promise.resolve()

    constructor(context: DurableObjectState, environment: Environment) {
      super(context, environment)
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS subscriptions (identity TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS revisions (subscription_id TEXT NOT NULL, channel TEXT NOT NULL, incarnation TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(subscription_id, channel));
        `)
      })
    }

    override async fetch(request: Request): Promise<Response> {
      try {
        if (request.headers.get("Upgrade") !== "websocket")
          return new Response("WebSocket required", { status: 426 })
        return await this.#open({
          sessionName: request.headers.get("X-Solid-Session-Name") ?? "",
          sessionId: request.headers.get("X-Solid-Session-Id") ?? "",
          expiresAt: Number(request.headers.get("X-Solid-Session-Expiry")),
        })
      } catch {
        return new Response("Unauthorized", { status: 401 })
      }
    }

    async #open(input: {
      sessionName: string
      sessionId: string
      expiresAt: number
    }): Promise<Response> {
      if (this.#session()) throw new Unauthorized("session connection already exists")
      if (
        !input.sessionId ||
        utf8ByteLength(input.sessionId) > 1_024 ||
        !Number.isFinite(input.expiresAt) ||
        input.expiresAt <= Date.now()
      )
        throw new Unauthorized("invalid session")
      const authorization = await options.resolveAuthorizationContext({
        sessionId: input.sessionId,
        environment: this.env,
      })
      if (authorization === null || input.expiresAt <= Date.now())
        throw new Unauthorized("session is not authorized")
      await this.#atomic(() => {
        if (this.#session()) throw new Unauthorized("session connection already exists")
        this.ctx.storage.kv.put("session", { ...input, closed: false })
      })
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].serializeAttachment({ sessionName: input.sessionName })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    override async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
      const receive = this.#receiving.then(async () => {
        if (typeof value !== "string" || utf8ByteLength(value) > 16_384)
          throw new TypeError("invalid subscription frame")
        const request = parseSubscriptionRequest(JSON.parse(value))
        const session = this.#session()
        if (!session || session.closed || session.expiresAt <= Date.now())
          throw new Unauthorized("session expired")
        const identity = actorName(request)
        const previous = this.#subscription(identity)
        if (request.action === "unsubscribe") {
          if (!previous) return
          previous.status = "removing"
          previous.retryAt = Date.now()
          await this.#atomic(() => this.#save(previous))
          await this.#synchronize(previous)
          return
        }
        if (!previous && this.#subscriptions().length >= maximum)
          throw new TypeError("subscription limit exceeded")
        const subscription: SessionSubscription = {
          actorType: request.actorType,
          actorId: request.actorId,
          id: previous?.id ?? crypto.randomUUID(),
          payloads: [...(request.payloads ?? [])],
          status: "registering",
          retryAt: Date.now(),
          incarnationOrder: previous?.incarnationOrder ?? "0",
        }
        await this.#atomic(() => {
          this.#save(subscription)
          this.ctx.storage.sql.exec(
            "DELETE FROM revisions WHERE subscription_id = ?",
            subscription.id,
          )
        })
        await this.#synchronize(subscription)
      })
      this.#receiving = receive.catch(() => undefined)
      try {
        await receive
      } catch {
        socket.close(1008, "subscription unavailable")
        await this.#close()
      }
    }

    async publish(input: { subscriptionId: string; event: JsonObject }): Promise<void> {
      const subscription = this.#subscriptions().find((entry) => entry.id === input.subscriptionId)
      if (!subscription || subscription.status === "removing") return
      const authorization = await this.#authorization()
      if (authorization === null) {
        await this.#close()
        return
      }
      let projected: JsonObject
      try {
        projected = jsonObject(
          await callHost({
            backend: options.backend(this.env),
            request: {
              ...subscription,
              method: "projection",
              authorizationContext: authorization,
              payload: { payloads: subscription.payloads },
            },
          }),
        )
      } catch (error) {
        if (!(error instanceof Unauthorized)) throw error
        subscription.status = "removing"
        await this.#atomic(() => this.#save(subscription))
        await this.#synchronize(subscription)
        return
      }
      const current = jsonObject(projected.event)
      if (current.instanceId !== input.event.instanceId) return
      this.#send(subscription, {
        envelope: input.event,
        incarnationOrder: String(projected.incarnationOrder),
      })
      for (const payload of payloadArray(projected.payloads))
        this.#send(subscription, {
          envelope: payload,
          incarnationOrder: String(projected.incarnationOrder),
        })
    }

    override async webSocketClose(socket: WebSocket): Promise<void> {
      socket.close(1000, "closed")
      await this.#close()
    }

    override async webSocketError(socket: WebSocket): Promise<void> {
      socket.close(1011, "connection failed")
      await this.#close()
    }

    override async alarm(): Promise<void> {
      const session = this.#session()
      if (session && session.expiresAt <= Date.now()) {
        for (const socket of this.ctx.getWebSockets()) socket.close(1008, "session expired")
        await this.#close()
      }
      for (const subscription of this.#subscriptions()) {
        if (subscription.status === "active" || subscription.retryAt > Date.now()) continue
        try {
          await this.#synchronize(subscription)
        } catch {
          await this.#defer(subscription)
        }
      }
      await this.#atomic(() => undefined)
    }

    #session(): SessionRecord | undefined {
      return this.ctx.storage.kv.get<SessionRecord>("session")
    }

    #subscriptions(): SessionSubscription[] {
      return this.ctx.storage.sql
        .exec<{ record: string }>("SELECT record FROM subscriptions")
        .toArray()
        .map((row) => JSON.parse(row.record) as SessionSubscription)
    }

    #subscription(identity: string): SessionSubscription | undefined {
      const row = this.ctx.storage.sql
        .exec<{ record: string }>("SELECT record FROM subscriptions WHERE identity = ?", identity)
        .toArray()[0]
      return row ? (JSON.parse(row.record) as SessionSubscription) : undefined
    }

    #save(subscription: SessionSubscription): void {
      this.ctx.storage.sql.exec(
        "INSERT INTO subscriptions(identity, id, record) VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET id = excluded.id, record = excluded.record",
        actorName(subscription),
        subscription.id,
        JSON.stringify(subscription),
      )
    }

    async #authorization(): Promise<JsonValue | null> {
      const session = this.#session()
      if (!session || session.closed || session.expiresAt <= Date.now()) return null
      const value = await options.resolveAuthorizationContext({
        sessionId: session.sessionId,
        environment: this.env,
      })
      return value === null ? null : normalizeJson(value)
    }

    async #synchronize(subscription: SessionSubscription): Promise<void> {
      const session = this.#session()
      if (!session) return
      const authorization = subscription.status === "removing" ? null : await this.#authorization()
      if (authorization === null) {
        subscription.status = "removing"
        await this.#atomic(() => {
          const current = this.#subscription(actorName(subscription))
          if (current?.id === subscription.id) this.#save({ ...current, status: "removing" })
        })
      }
      await this.#defer(subscription)
      const projected = await callHost({
        backend: options.backend(this.env),
        request: {
          ...subscription,
          method: subscription.status === "removing" ? "unsubscribe" : "subscribe",
          authorizationContext: authorization,
          payload: {
            subscriptionId: subscription.id,
            sessionName: session.sessionName,
            expiresAt: session.expiresAt,
            payloads: subscription.payloads,
          },
        },
      })
      await this.#atomic(() => {
        const current = this.#subscription(actorName(subscription))
        if (!current || current.id !== subscription.id) return
        if (subscription.status === "removing") {
          this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE id = ?", subscription.id)
          this.ctx.storage.sql.exec(
            "DELETE FROM revisions WHERE subscription_id = ?",
            subscription.id,
          )
          return
        }
        if (current.status === "removing" || this.#session()?.closed) return
        subscription.status = "active"
        this.#save({ ...current, status: "active" })
      })
      if (subscription.status !== "active" || projected === null) return
      const projection = jsonObject(projected)
      this.#send(subscription, {
        envelope: jsonObject(projection.event),
        incarnationOrder: String(projection.incarnationOrder),
      })
      for (const payload of payloadArray(projection.payloads))
        this.#send(subscription, {
          envelope: payload,
          incarnationOrder: String(projection.incarnationOrder),
        })
    }

    async #defer(subscription: SessionSubscription): Promise<void> {
      subscription.retryAt = Date.now() + 30_000
      await this.#atomic(() => {
        const current = this.#subscription(actorName(subscription))
        if (!current || current.id !== subscription.id) return
        this.#save({ ...current, retryAt: subscription.retryAt })
      })
    }

    #send(
      subscription: SessionSubscription,
      delivery: { envelope: JsonObject; incarnationOrder: string },
    ): void {
      const { envelope, incarnationOrder } = delivery
      const session = this.#session()
      const current = this.#subscription(actorName(subscription))
      if (
        !session ||
        session.closed ||
        session.expiresAt <= Date.now() ||
        !current ||
        current.id !== subscription.id ||
        current.status === "removing"
      )
        return
      const channel =
        envelope.kind === "payload" ? `payload:${String(envelope.name)}` : "invalidation"
      const incarnation = String(envelope.instanceId)
      const revision = String(envelope.revision)
      this.ctx.storage.transactionSync(() => {
        if (BigInt(incarnationOrder) < BigInt(current.incarnationOrder)) return
        if (BigInt(incarnationOrder) > BigInt(current.incarnationOrder)) {
          this.ctx.storage.sql.exec(
            "DELETE FROM revisions WHERE subscription_id = ?",
            subscription.id,
          )
          this.#save({ ...current, incarnationOrder })
        }
        const previous = this.ctx.storage.sql
          .exec<{ incarnation: string; revision: string }>(
            "SELECT incarnation, revision FROM revisions WHERE subscription_id = ? AND channel = ?",
            subscription.id,
            channel,
          )
          .toArray()[0]
        if (previous?.incarnation === incarnation && BigInt(previous.revision) >= BigInt(revision))
          return
        this.ctx.storage.sql.exec(
          "INSERT INTO revisions(subscription_id, channel, incarnation, revision) VALUES (?, ?, ?, ?) ON CONFLICT(subscription_id, channel) DO UPDATE SET incarnation = excluded.incarnation, revision = excluded.revision",
          subscription.id,
          channel,
          incarnation,
          revision,
        )
        for (const socket of this.ctx.getWebSockets()) socket.send(JSON.stringify(envelope))
      })
    }

    async #close(): Promise<void> {
      await this.#atomic(() => {
        const session = this.#session()
        if (session) this.ctx.storage.kv.put("session", { ...session, closed: true })
        for (const subscription of this.#subscriptions())
          this.#save({ ...subscription, status: "removing", retryAt: Date.now() })
      })
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState < WebSocket.CLOSING) socket.close(1008, "session closed")
      }
    }

    async #atomic(callback: () => void): Promise<void> {
      await this.ctx.storage.transaction(async () => {
        callback()
        const session = this.#session()
        const due = this.#subscriptions()
          .filter((subscription) => subscription.status !== "active")
          .map((subscription) => subscription.retryAt)
        if (session && !session.closed) due.push(session.expiresAt)
        if (due.length === 0) {
          await this.ctx.storage.deleteAlarm()
          return
        }
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...due)))
      })
    }
  }
}

function payloadArray(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError("invalid projection payloads")
  return value.map((payload) => jsonObject(payload))
}

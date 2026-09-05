import type { Actor, ActorClass, ActorIntents } from "../actor.js"
import { withActorContext, withActorProjection, withRuntime } from "../context.js"
import {
  actorState,
  hydrateActor,
  initialStateFor,
  migrateState,
  validateDefinition,
  type ValidatedActorDefinition,
} from "../definition.js"
import {
  ActorDestroyed,
  IdempotencyConflict,
  MailboxFull,
  NonRetryableError,
  PayloadTooLarge,
  QueryMutatedState,
  Rejected,
  ReminderNotPaused,
  Unauthorized,
  UnknownActorType,
  UnknownDeadLetter,
  UnknownEffect,
  UnknownOperation,
  UnknownPayloadBroadcast,
  UnknownReminder,
  UnsupportedCapability,
} from "../errors.js"
import { deepCopy, jsonObject, normalizeJson, stableJson } from "../serialization.js"
import { evaluateActorTurn, readActorObservables, selectActorBroadcast } from "../turn.js"
import type { JsonObject, JsonValue } from "../types.js"
import type { CloudflareSettings } from "./configuration.js"
import { actorName, callHost, type ActorIdentity, type HostRequest } from "./protocol.js"
import type { Instance, Message, Outbox, Reminder, Subscription } from "./records.js"
import { beforeDeadline, CloudflareRuntime } from "./runtime.js"
import { ActorStorage } from "./storage.js"

const RECOVERY_INTERVAL = 30_000

export class ActorEngine {
  readonly runtime: CloudflareRuntime
  private readonly definitions = new Map<string, ValidatedActorDefinition>()
  private actorRunning = false
  private readonly delivering = new Set<string>()
  private cached: { incarnation: string; actor: Actor } | undefined

  constructor(
    readonly store: ActorStorage,
    actors: readonly ActorClass[],
  ) {
    this.runtime = new CloudflareRuntime(store.settings.backend)
    for (const actor of actors) {
      const definition = validateDefinition(actor)
      if (this.definitions.has(definition.type))
        throw new TypeError(`duplicate actor type ${definition.type}`)
      this.definitions.set(definition.type, definition)
    }
  }

  get settings(): CloudflareSettings {
    return this.store.settings
  }

  async request(input: HostRequest): Promise<JsonValue> {
    if (input.method === "enqueue" || input.method === "internal") {
      const operation = String(input.payload.operation)
      if (input.method === "enqueue")
        await this.authorizeOperation(input, {
          operation,
          arguments: jsonObject(input.payload.arguments),
        })
      this.bind(input)
      return this.store.atomic(() => normalizeJson(this.enqueue(input)))
    }
    if (input.method === "message" || input.method === "lookup") return this.readMessage(input)
    if (input.method === "administration") return this.administer(input)
    if (input.method === "destroy") {
      if (!(await this.settings.authorizeDestroy(input)))
        throw new Unauthorized("actor destruction is not authorized")
      this.bind(input)
      return this.store.atomic(() => this.destroy())
    }
    if (input.method === "unsubscribe") {
      this.bind(input)
      await this.store.atomic(() => {
        this.store.storage.sql.exec(
          "DELETE FROM subscriptions WHERE id = ?",
          String(input.payload.subscriptionId),
        )
        this.store.storage.sql.exec(
          "DELETE FROM outboxes WHERE kind = 'broadcast' AND destination = ?",
          String(input.payload.subscriptionId),
        )
      })
      return null
    }
    if (input.method === "snapshot") {
      if (
        !(await this.settings.authorizeQuery({
          ...input,
          operation: "__snapshot__",
          arguments: {},
        }))
      )
        throw new Unauthorized("actor snapshot is not authorized")
      this.bind(input)
      return this.snapshot(input)
    }
    if (!(await this.settings.authorizeSubscription(input)))
      throw new Unauthorized("actor subscription is not authorized")
    this.bind(input)
    const payloadNames = stringList(input.payload.payloads ?? [])
    const definition = this.definition(input.actorType)
    for (const name of payloadNames) {
      if (!definition.payloads[name]) throw new UnknownPayloadBroadcast(`unknown payload ${name}`)
    }
    if (input.method === "subscribe") {
      const expiresAt = Number(input.payload.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new Unauthorized("subscription expired")
      await this.store.atomic(() =>
        this.store.saveSubscription({
          id: String(input.payload.subscriptionId),
          sessionName: String(input.payload.sessionName),
          payloads: payloadNames,
          expiresAt,
        }),
      )
    }
    return this.projection({ input, payloadNames })
  }

  async pump(): Promise<void> {
    await this.store.atomic(() => {
      this.store.prune()
      this.scheduleReminders()
      if (this.actorRunning) {
        const head = this.store.head()
        if (head?.status === "claimed") {
          head.availableAt = Date.now() + RECOVERY_INTERVAL
          this.store.saveMessage(head)
        }
      }
      for (const outbox of this.store.outboxHeads()) {
        if (!this.delivering.has(outbox.id)) continue
        outbox.availableAt = Date.now() + RECOVERY_INTERVAL
        this.store.saveOutbox(outbox)
      }
    })
    const work: Promise<void>[] = []
    if (!this.actorRunning) work.push(this.drainActors())
    for (const outbox of this.store.outboxHeads()) {
      if (outbox.availableAt > Date.now() || this.delivering.has(outbox.id)) continue
      work.push(this.deliver(outbox))
    }
    await Promise.all(work)
    await this.store.atomic(() => undefined)
  }

  private bind(identity: ActorIdentity): void {
    const name = actorName(identity)
    const existing = this.store.metadata<string>("identity")
    if (existing !== undefined && existing !== name)
      throw new Unauthorized("Durable Object identity mismatch")
    this.definition(identity.actorType)
    if (existing === undefined) this.store.saveMetadata("identity", name)
  }

  private definition(type: string): ValidatedActorDefinition {
    const definition = this.definitions.get(type)
    if (!definition) throw new UnknownActorType(`unknown actor type ${type}`)
    return definition
  }

  private ensureInstance(identity: ActorIdentity): Instance {
    const existing = this.store.instance()
    if (existing) return existing
    const definition = this.definition(identity.actorType)
    const incarnationOrder = String(
      BigInt(this.store.metadata<string>("incarnationOrder") ?? "0") + 1n,
    )
    this.store.saveMetadata("incarnationOrder", incarnationOrder)
    const instance: Instance = {
      actorType: identity.actorType,
      actorId: identity.actorId,
      incarnation: crypto.randomUUID(),
      incarnationOrder,
      generation: "1",
      revision: "0",
      nextSequence: "1",
      state: initialStateFor(definition),
      stateVersion: definition.stateVersion,
      createdAt: Date.now(),
      paused: false,
    }
    this.store.saveInstance(instance)
    return instance
  }

  private enqueue(input: HostRequest): Message {
    const definition = this.definition(input.actorType)
    const operation = String(input.payload.operation)
    const deliveryMode = input.method === "internal" ? "internal" : input.payload.deliveryMode
    if (deliveryMode !== "sync" && deliveryMode !== "async" && deliveryMode !== "internal")
      throw new TypeError("invalid delivery mode")
    if (
      !definition.operations.includes(operation) &&
      !(deliveryMode === "sync" && definition.queries.includes(operation))
    )
      throw new UnknownOperation(`unknown operation ${operation}`)
    const argumentsValue = jsonObject(input.payload.arguments, {
      maxBytes: this.settings.maxPayloadBytes,
    })
    const requestId = String(input.payload.requestId)
    if (requestId.length === 0 || requestId.length > 512) throw new TypeError("invalid request ID")
    const availableAt = Number(input.payload.availableAt)
    if (!Number.isFinite(availableAt)) throw new TypeError("invalid availability time")
    const idempotencyKey =
      input.payload.idempotencyKey === null || input.payload.idempotencyKey === undefined
        ? null
        : String(input.payload.idempotencyKey)
    const instance = this.ensureInstance(input)
    const receipt = this.store.storage.sql
      .exec<{ message_id: string }>(
        "SELECT message_id FROM receipts WHERE request_id = ?",
        requestId,
      )
      .toArray()[0]
    const previous = receipt
      ? this.store.message(receipt.message_id)
      : idempotencyKey === null
        ? undefined
        : this.store.rows<Message>(
            "SELECT record FROM messages WHERE incarnation = ? AND idempotency_key = ?",
            [instance.incarnation, idempotencyKey],
          )[0]
    if (previous) {
      if (previous.incarnation !== instance.incarnation)
        throw new ActorDestroyed("the accepted message belongs to a destroyed actor")
      if (
        previous.operation !== operation ||
        previous.deliveryMode !== deliveryMode ||
        stableJson(previous.arguments) !== stableJson(argumentsValue)
      )
        throw new IdempotencyConflict(
          "request ID or idempotency key already identifies different work",
        )
      this.store.storage.sql.exec(
        "INSERT OR IGNORE INTO receipts(request_id, message_id) VALUES (?, ?)",
        requestId,
        previous.id,
      )
      return previous
    }
    const count = this.store.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM messages WHERE incarnation = ? AND status IN ('ready', 'claimed')",
        instance.incarnation,
      )
      .one().count
    if (count >= this.settings.maxMailboxLength) throw new MailboxFull("actor mailbox is full")
    if (BigInt(instance.nextSequence) > 9_223_372_036_854_775_807n)
      throw new NonRetryableError("actor mailbox sequence exhausted")
    const message: Message = {
      id: crypto.randomUUID(),
      requestId,
      incarnation: instance.incarnation,
      sequence: instance.nextSequence,
      operation,
      arguments: argumentsValue,
      deliveryMode,
      idempotencyKey,
      status: "ready",
      attempt: 0,
      availableAt,
      createdAt: Date.now(),
      completedAt: null,
      result: null,
      error: null,
      rejection: null,
      generation: null,
      reminder: null,
    }
    instance.nextSequence = String(BigInt(instance.nextSequence) + 1n)
    this.store.saveInstance(instance)
    this.store.saveMessage(message)
    this.store.storage.sql.exec(
      "INSERT INTO receipts(request_id, message_id) VALUES (?, ?)",
      requestId,
      message.id,
    )
    return message
  }

  private async authorizeOperation(
    input: HostRequest,
    message: { operation: string; arguments: JsonObject },
  ): Promise<void> {
    const query =
      this.definitions.get(input.actorType)?.queries.includes(message.operation) ?? false
    const policy = query ? this.settings.authorizeQuery : this.settings.authorizeMessage
    if (!(await policy({ ...input, operation: message.operation, arguments: message.arguments })))
      throw new Unauthorized("actor operation is not authorized")
  }

  private async readMessage(input: HostRequest): Promise<JsonValue> {
    let message: Message | undefined
    if (input.method === "lookup") {
      if (
        !(await this.settings.authorizeQuery({
          ...input,
          operation: "__lookupMessage__",
          arguments: {},
        }))
      )
        throw new Unauthorized("message lookup is not authorized")
      const receipt = this.store.storage.sql
        .exec<{ message_id: string }>(
          "SELECT message_id FROM receipts WHERE request_id = ?",
          String(input.payload.requestId),
        )
        .toArray()[0]
      message = receipt ? this.store.message(receipt.message_id) : undefined
      if (!message) return null
    } else {
      message = this.store.message(String(input.payload.id))
      if (
        !message ||
        message.requestId !== input.payload.requestId ||
        message.sequence !== input.payload.sequence
      )
        throw new Unauthorized("message reference is not authorized")
    }
    await this.authorizeOperation(input, message)
    this.bind(input)
    if (message.incarnation !== this.store.instance()?.incarnation)
      throw new ActorDestroyed("actor was destroyed")
    return normalizeJson(message)
  }

  private committed(identity: ActorIdentity) {
    const definition = this.definition(identity.actorType)
    const instance = this.store.instance()
    const state = instance
      ? migrateState({
          definition,
          storedVersion: instance.stateVersion,
          storedState: instance.state,
        })
      : initialStateFor(definition)
    return { definition, instance, state }
  }

  private async snapshot(identity: ActorIdentity): Promise<JsonObject> {
    const { definition, instance, state } = this.committed(identity)
    const actor = hydrateActor({ definition, actorId: identity.actorId, state })
    const before = stableJson(actorState(actor, definition.stateKeys))
    const snapshot: JsonObject = { ...state }
    await withActorProjection({ actor, runtime: this.runtime }, async () => {
      for (const query of definition.queries) {
        if (definition.stateKeys.includes(query)) continue
        const value = await actor.invoke(query, {})
        snapshot[query] = normalizeJson(value === undefined ? null : value, {
          maxBytes: this.settings.maxResultBytes,
        })
      }
    })
    if (stableJson(actorState(actor, definition.stateKeys)) !== before || actor.hasIntents())
      throw new QueryMutatedState("snapshot getters must not mutate state or stage work")
    return {
      snapshot,
      instanceId: instance?.incarnation ?? "0",
      revision: instance?.revision ?? "0",
      createdAtMs: instance?.createdAt ?? 0,
    }
  }

  private async projection(options: {
    input: HostRequest
    payloadNames: string[]
  }): Promise<JsonObject> {
    const { input, payloadNames } = options
    const { definition, instance, state } = this.committed(input)
    const actor = hydrateActor({ definition, actorId: input.actorId, state })
    const identity = {
      actorType: input.actorType,
      actorId: input.actorId,
      instanceId: instance?.incarnation ?? "0",
      revision: instance?.revision ?? "0",
    }
    const event = {
      version: 1,
      kind: "invalidation",
      ...identity,
      ...selectActorBroadcast(readActorObservables({ actor, definition, runtime: this.runtime })),
    }
    const payloads: JsonObject[] = []
    for (const name of payloadNames) {
      try {
        if (!(await this.settings.authorizeQuery({ ...input, operation: name, arguments: {} })))
          continue
        const projected = hydrateActor({
          definition,
          actorId: input.actorId,
          state: deepCopy(state),
        })
        const before = stableJson(actorState(projected, definition.stateKeys))
        const handler = definition.payloads[name]!
        const value = await withActorProjection({ actor: projected, runtime: this.runtime }, () =>
          handler(projected, input.authorizationContext),
        )
        if (
          stableJson(actorState(projected, definition.stateKeys)) !== before ||
          projected.hasIntents()
        )
          throw new QueryMutatedState("payload projection mutated state")
        const payload = normalizeJson(value, { maxBytes: this.settings.maxPayloadBytes })
        if (payload === null || typeof payload !== "object")
          throw new TypeError("payload must be an object or array")
        payloads.push({ version: 1, kind: "payload", ...identity, name, payload })
      } catch (error) {
        this.emit("payload_broadcast.failed", { payload: name, errorName: errorName(error) })
      }
    }
    return {
      event,
      payloads,
      incarnationOrder:
        instance?.incarnationOrder ?? this.store.metadata<string>("incarnationOrder") ?? "0",
    }
  }

  private destroy(): boolean {
    const instance = this.store.instance()
    if (!instance) return false
    this.store.storage.sql.exec("DELETE FROM metadata WHERE key = 'instance'")
    this.store.storage.sql.exec("DELETE FROM outboxes")
    this.store.storage.sql.exec("DELETE FROM reminders")
    for (const message of this.store.rows<Message>(
      "SELECT record FROM messages WHERE incarnation = ? AND completed_at IS NULL",
      [instance.incarnation],
    )) {
      message.status = "completed"
      message.completedAt = Date.now()
      this.store.saveMessage(message)
    }
    this.cached = undefined
    this.emit("actor.destroyed")
    return true
  }

  private async drainActors(): Promise<void> {
    this.actorRunning = true
    const started = Date.now()
    try {
      for (let count = 0; count < this.settings.maxMessagesPerActivationPass; count += 1) {
        if (Date.now() - started >= this.settings.maxActivationDurationMilliseconds) break
        const head = this.store.head()
        if (!head || head.status !== "ready" || head.availableAt > Date.now()) break
        await this.execute(head)
      }
    } finally {
      this.actorRunning = false
    }
  }

  private async execute(message: Message): Promise<void> {
    const instance = this.store.instance()!
    const definition = this.definition(instance.actorType)
    let actor: Actor
    try {
      actor =
        this.cached?.incarnation === instance.incarnation
          ? this.cached.actor
          : hydrateActor({
              definition,
              actorId: instance.actorId,
              state: migrateState({
                definition,
                storedVersion: instance.stateVersion,
                storedState: instance.state,
              }),
            })
      if (this.cached?.actor !== actor) {
        await withActorContext({ actor, runtime: this.runtime }, () => actor.activate())
        this.assertCurrent(instance)
        this.cached = { incarnation: instance.incarnation, actor }
      }
    } catch (error) {
      if (error instanceof ActorDestroyed) return
      await this.store.atomic(() => {
        if (this.store.instance()?.incarnation !== instance.incarnation) return
        message.availableAt = Date.now() + RECOVERY_INTERVAL
        message.error = {
          name: "ActorSetupFailed",
          message: "actor setup failed",
          cause: {
            name: errorName(error),
            message: error instanceof Error ? error.message.slice(0, 4_096) : "actor setup failed",
          },
        }
        this.store.saveMessage(message)
      })
      this.emit("actor.setup_failed", { errorName: errorName(error) })
      return
    }
    const stateBefore = deepCopy(actorState(actor, definition.stateKeys))
    try {
      await this.store.atomic(() => {
        this.assertCurrent(instance)
        message.status = "claimed"
        message.generation = instance.generation
        message.attempt += 1
        message.availableAt = Date.now() + RECOVERY_INTERVAL
        this.store.saveMessage(message)
      })
      this.emit("message.started", { messageId: message.id, attempt: message.attempt })
      const evaluated = await evaluateActorTurn({
        actor,
        definition,
        runtime: this.runtime,
        stateBefore,
        operation: message.operation,
        argumentsValue: message.arguments,
        message: {
          id: message.id,
          requestId: message.requestId,
          actorType: instance.actorType,
          actorId: instance.actorId,
          sequence: BigInt(message.sequence),
          attempt: message.attempt,
          enqueuedAt: new Date(message.createdAt),
          idempotencyKey: message.idempotencyKey,
        },
        maxStateBytes: this.settings.maxStateBytes,
        maxResultBytes: this.settings.maxResultBytes,
      })
      const intents = actor.drainIntents()
      if (intents.commitActions.length > 0)
        throw new UnsupportedCapability("the Durable Objects backend does not support commitAction")
      await this.store.atomic(() => {
        const current = this.assertCurrent(instance)
        current.state = evaluated.state
        current.stateVersion = definition.stateVersion
        current.revision = message.sequence
        this.store.saveInstance(current)
        message.status = "completed"
        message.result = evaluated.result
        message.completedAt = Date.now()
        this.store.saveMessage(message)
        this.stage({ instance: current, message, intents, broadcast: evaluated.broadcast })
        this.completeReminder(message)
      })
      this.emit("message.completed", { messageId: message.id })
    } catch (error) {
      actor.discardIntents()
      for (const key of definition.stateKeys)
        Object.assign(actor, { [key]: deepCopy(stateBefore[key]) })
      if (error instanceof ActorDestroyed) return
      await this.store.atomic(() => {
        const current = this.store.instance()
        if (
          !current ||
          current.incarnation !== instance.incarnation ||
          current.generation !== instance.generation
        )
          return
        message.result = null
        message.completedAt = null
        message.rejection = null
        if (error instanceof Rejected) {
          message.status = "rejected"
          message.rejection = {
            code: error.code,
            message: error.message,
            details: jsonObject(error.details),
          }
          message.completedAt = Date.now()
          this.completeReminder(message)
        } else {
          message.error = {
            name: errorName(error),
            message: error instanceof Error ? error.message.slice(0, 4_096) : "operation failed",
          }
          const exhausted =
            error instanceof NonRetryableError || message.attempt >= this.settings.maxAttempts
          message.status = exhausted ? "dead" : "ready"
          message.availableAt = Date.now() + this.retryDelay(message.attempt)
          if (exhausted) {
            current.paused = true
            this.store.saveInstance(current)
            this.pauseReminder(message)
          }
        }
        try {
          this.store.saveMessage(message)
        } catch (storageError) {
          if (!(storageError instanceof PayloadTooLarge)) throw storageError
          message.status = "dead"
          message.completedAt = null
          message.rejection = null
          message.error = { name: storageError.name, message: storageError.message }
          current.paused = true
          this.store.saveInstance(current)
          this.pauseReminder(message)
          this.store.saveMessage(message)
        }
      })
      this.emit("message.failed", {
        messageId: message.id,
        errorName: errorName(error),
        status: message.status,
      })
    }
  }

  private assertCurrent(instance: Instance): Instance {
    const current = this.store.instance()
    if (
      !current ||
      current.incarnation !== instance.incarnation ||
      current.generation !== instance.generation
    )
      throw new ActorDestroyed("actor incarnation or execution generation changed")
    return current
  }

  private stage(options: {
    instance: Instance
    message: Message
    intents: ActorIntents
    broadcast: { observables: JsonObject; invalidations: string[] } | undefined
  }): void {
    const { instance, message, intents, broadcast } = options
    for (const effect of intents.effects) {
      const id = crypto.randomUUID()
      this.addOutbox({
        id,
        instance,
        message,
        kind: "effect",
        destination: id,
        payload: jsonObject(effect),
      })
    }
    for (const outbound of intents.outboundMessages) {
      this.addOutbox({
        id: crypto.randomUUID(),
        instance,
        message,
        kind: "outbound",
        destination: actorName(outbound),
        payload: jsonObject(outbound),
      })
    }
    for (const intent of intents.reminders) {
      this.store.saveReminder({
        name: intent.name,
        generation: crypto.randomUUID(),
        operation: intent.operation,
        arguments: intent.arguments,
        at: intent.atMilliseconds,
        interval: intent.intervalMilliseconds ?? null,
        missed: intent.missedPolicy,
        status: "scheduled",
      })
    }
    if (!broadcast) return
    for (const subscription of this.store.rows<Subscription>(
      "SELECT record FROM subscriptions WHERE expires_at > ?",
      [Date.now()],
    )) {
      this.addOutbox({
        id: crypto.randomUUID(),
        instance,
        message,
        kind: "broadcast",
        destination: subscription.id,
        payload: {
          sessionName: subscription.sessionName,
          event: {
            version: 1,
            kind: "invalidation",
            actorType: instance.actorType,
            actorId: instance.actorId,
            instanceId: instance.incarnation,
            revision: message.sequence,
            ...broadcast,
          },
        },
      })
    }
  }

  private addOutbox(options: {
    id: string
    instance: Instance
    message: Pick<Message, "id" | "sequence">
    kind: Outbox["kind"]
    destination: string
    payload: JsonObject
  }): void {
    this.store.saveOutbox({
      id: options.id,
      incarnation: options.instance.incarnation,
      messageId: options.message.id,
      sequence: options.message.sequence,
      kind: options.kind,
      destination: options.destination,
      payload: options.payload,
      status: "pending",
      attempt: 0,
      availableAt: Date.now(),
      completedAt: null,
      error: null,
    })
  }

  private async deliver(outbox: Outbox): Promise<void> {
    this.delivering.add(outbox.id)
    const instance = this.store.instance()
    if (!instance || instance.incarnation !== outbox.incarnation) {
      this.delivering.delete(outbox.id)
      return
    }
    try {
      await this.store.atomic(() => {
        if (!this.outboxCurrent(outbox, instance)) throw new ActorDestroyed("outbox was removed")
        outbox.status = "claimed"
        outbox.attempt += 1
        outbox.availableAt = Date.now() + RECOVERY_INTERVAL
        this.store.saveOutbox(outbox)
      })
      let result: JsonValue = null
      if (outbox.kind === "effect") {
        const handler = this.settings.effects[String(outbox.payload.name)]
        if (!handler) throw new UnknownEffect(`unknown effect ${String(outbox.payload.name)}`)
        const value = await withRuntime(this.runtime, () =>
          handler(jsonObject(outbox.payload.arguments), {
            id: outbox.id,
            attempt: outbox.attempt,
            sourceMessageId: outbox.messageId,
            actorType: instance.actorType,
            actorId: instance.actorId,
          }),
        )
        result = normalizeJson(value === undefined ? null : value, {
          maxBytes: this.settings.maxResultBytes,
        })
      } else if (outbox.kind === "effect-callback") {
        await callHost({
          backend: this.settings.backend,
          request: {
            actorType: instance.actorType,
            actorId: instance.actorId,
            method: "internal",
            authorizationContext: null,
            payload: {
              requestId: outbox.id,
              operation: String(outbox.payload.operation),
              arguments: jsonObject(outbox.payload.arguments),
              availableAt: Date.now(),
              idempotencyKey: outbox.id,
            },
          },
        })
      } else if (outbox.kind === "outbound") {
        await callHost({
          backend: this.settings.backend,
          request: {
            actorType: String(outbox.payload.actorType),
            actorId: String(outbox.payload.actorId),
            method: "internal",
            authorizationContext: null,
            payload: {
              requestId: outbox.id,
              operation: outbox.payload.operation!,
              arguments: outbox.payload.arguments!,
              availableAt: outbox.payload.availableAtMilliseconds ?? Date.now(),
              idempotencyKey: outbox.payload.idempotencyKey ?? outbox.id,
            },
          },
        })
      } else {
        const subscription = this.store.rows<Subscription>(
          "SELECT record FROM subscriptions WHERE id = ? AND expires_at > ?",
          [outbox.destination, Date.now()],
        )[0]
        if (subscription && this.settings.backend.sessions) {
          await beforeDeadline(
            this.settings.backend.sessions.getByName(subscription.sessionName).publish({
              subscriptionId: subscription.id,
              event: jsonObject(outbox.payload.event),
            }),
            5_000,
          )
        }
      }
      await this.store.atomic(() => {
        if (!this.outboxCurrent(outbox, instance)) return
        outbox.status = "completed"
        outbox.completedAt = Date.now()
        this.store.saveOutbox(outbox)
        if (outbox.kind === "effect")
          this.stageEffectCallback({
            instance,
            outbox,
            result,
            operation: outbox.payload.successOperation,
          })
      })
    } catch (error) {
      await this.store.atomic(() => {
        if (!this.outboxCurrent(outbox, instance)) return
        const exhausted =
          error instanceof NonRetryableError || outbox.attempt >= this.settings.maxAttempts
        outbox.status = exhausted ? "dead" : "pending"
        outbox.error = {
          name: errorName(error),
          message: error instanceof Error ? error.message : "delivery failed",
        }
        outbox.availableAt = Date.now() + this.retryDelay(outbox.attempt)
        this.store.saveOutbox(outbox)
        if (exhausted && outbox.kind === "effect")
          this.stageEffectCallback({
            instance,
            outbox,
            result: outbox.error,
            operation: outbox.payload.failureOperation,
          })
      })
      this.emit("outbox.failed", {
        outboxId: outbox.id,
        kind: outbox.kind,
        errorName: errorName(error),
      })
    } finally {
      this.delivering.delete(outbox.id)
    }
  }

  private outboxCurrent(outbox: Outbox, instance: Instance): boolean {
    const current = this.store.instance()
    return (
      current?.incarnation === outbox.incarnation &&
      current.generation === instance.generation &&
      this.store.rows<Outbox>("SELECT record FROM outboxes WHERE id = ?", [outbox.id]).length > 0
    )
  }

  private stageEffectCallback(options: {
    instance: Instance
    outbox: Outbox
    result: JsonValue
    operation: JsonValue | undefined
  }): void {
    if (typeof options.operation !== "string") return
    this.addOutbox({
      id: `${options.outbox.id}:callback`,
      instance: options.instance,
      message: {
        id: options.outbox.messageId,
        sequence: options.outbox.sequence,
      },
      kind: "effect-callback",
      destination: actorName(options.instance),
      payload: {
        operation: options.operation,
        arguments: {
          effectId: options.outbox.id,
          arguments: options.outbox.payload.arguments!,
          ...(options.outbox.status === "dead"
            ? { error: options.result }
            : { result: options.result }),
        },
      },
    })
  }

  private scheduleReminders(): void {
    const instance = this.store.instance()
    if (!instance || instance.paused) return
    for (const reminder of this.store.rows<Reminder>(
      "SELECT record FROM reminders WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at LIMIT ?",
      [Date.now(), this.settings.maxMessagesPerActivationPass],
    )) {
      try {
        const message = this.enqueue({
          ...instance,
          method: "internal",
          authorizationContext: null,
          payload: {
            requestId: `reminder:${reminder.generation}:${reminder.at}`,
            operation: reminder.operation,
            arguments: reminder.arguments,
            idempotencyKey: `reminder:${reminder.generation}:${reminder.at}`,
            availableAt: reminder.at,
          },
        })
        message.reminder = { name: reminder.name, generation: reminder.generation }
        this.store.saveMessage(message)
        reminder.status = "completed"
        this.store.saveReminder(reminder)
      } catch (error) {
        if (!(error instanceof MailboxFull)) throw error
        break
      }
    }
  }

  private completeReminder(message: Message): void {
    if (!message.reminder) return
    const reminder = this.store.rows<Reminder>("SELECT record FROM reminders WHERE name = ?", [
      message.reminder.name,
    ])[0]
    if (
      !reminder ||
      reminder.generation !== message.reminder.generation ||
      reminder.interval === null
    )
      return
    const steps =
      reminder.missed === "latest"
        ? Math.max(1, Math.floor((Date.now() - reminder.at) / reminder.interval) + 1)
        : 1
    reminder.at += steps * reminder.interval
    reminder.status = "scheduled"
    this.store.saveReminder(reminder)
  }

  private pauseReminder(message: Message): void {
    if (!message.reminder) return
    const reminder = this.store.rows<Reminder>("SELECT record FROM reminders WHERE name = ?", [
      message.reminder.name,
    ])[0]
    if (!reminder || reminder.generation !== message.reminder.generation) return
    reminder.status = "paused"
    this.store.saveReminder(reminder)
  }

  private async administer(input: HostRequest): Promise<JsonValue> {
    const action = String(input.payload.action)
    if (
      !(await this.settings.authorizeAdministration({
        action,
        resource: `actor:${actorName(input)}`,
        authorizationContext: input.authorizationContext,
      }))
    )
      throw new Unauthorized("actor administration is not authorized")
    this.bind(input)
    if (action === "deadLetters")
      return normalizeJson({
        messages: this.store.rows<Message>(
          "SELECT record FROM messages WHERE status = 'dead' ORDER BY sequence LIMIT 1000",
        ),
        outboxes: this.store.rows<Outbox>(
          "SELECT record FROM outboxes WHERE status = 'dead' ORDER BY sequence LIMIT 1000",
        ),
      })
    if (action === "reminders")
      return normalizeJson(
        this.store.rows<Reminder>("SELECT record FROM reminders ORDER BY due_at LIMIT 1000"),
      )
    return this.store.atomic(() => {
      if (action === "retryDeadLetter") {
        const id = String(input.payload.id)
        const message = this.store.message(id)
        if (
          message?.status === "dead" &&
          message.incarnation === this.store.instance()?.incarnation
        ) {
          message.status = "ready"
          message.attempt = 0
          message.availableAt = Date.now()
          this.store.saveMessage(message)
          const instance = this.store.instance()!
          instance.paused = false
          this.store.saveInstance(instance)
          return normalizeJson(message)
        }
        const outbox = this.store.rows<Outbox>(
          "SELECT record FROM outboxes WHERE id = ? AND status = 'dead'",
          [id],
        )[0]
        if (!outbox) throw new UnknownDeadLetter("unknown dead letter")
        outbox.status = "pending"
        outbox.attempt = 0
        outbox.availableAt = Date.now()
        this.store.saveOutbox(outbox)
        return normalizeJson(outbox)
      }
      if (action === "resumeReminder") {
        const reminder = this.store.rows<Reminder>("SELECT record FROM reminders WHERE name = ?", [
          String(input.payload.name),
        ])[0]
        if (!reminder) throw new UnknownReminder("unknown reminder")
        if (reminder.status !== "paused") throw new ReminderNotPaused("reminder is not paused")
        const at = Number(input.payload.runAt)
        if (!Number.isFinite(at)) throw new TypeError("invalid reminder runAt")
        reminder.at = at
        reminder.status = "scheduled"
        reminder.generation = crypto.randomUUID()
        this.store.saveReminder(reminder)
        const instance = this.store.instance()
        if (instance) {
          instance.paused = false
          this.store.saveInstance(instance)
        }
        return normalizeJson(reminder)
      }
      throw new UnsupportedCapability(`unsupported actor administration action ${action}`)
    })
  }

  private retryDelay(attempt: number): number {
    const delay = this.settings.retryDelayMilliseconds(attempt)
    return Number.isFinite(delay) && delay >= 1 ? delay : 1_000
  }

  private emit(name: string, attributes: JsonObject = {}): void {
    try {
      this.settings.instrumentation?.({
        name: `solid_objects.${name}`,
        occurredAt: new Date().toISOString(),
        attributes,
      })
    } catch {
      this.settings.logger.error({ event: "solid_objects.instrumentation.failed", name })
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error"
}

function stringList(value: JsonValue): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    !value.every((item) => typeof item === "string")
  )
    throw new TypeError("payloads must contain at most 50 names")
  return [...new Set(value)]
}

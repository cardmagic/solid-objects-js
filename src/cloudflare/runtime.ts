import "./platform.js"
import type { Actor, ActorClass } from "../actor.js"
import type { ActorRuntime } from "../actor-runtime.js"
import { currentActor } from "../context.js"
import { validateDefinition } from "../definition.js"
import {
  ActorCallCycle,
  ActorSetupFailed,
  EnqueueOutcomeUnknown,
  MessageFailed,
  Rejected,
  SyncTimeout,
  UnsupportedCapability,
} from "../errors.js"
import {
  ActorReferenceCore,
  createActorReference,
  MessageReference,
  type ActorReference,
  type ActorSnapshot,
} from "../reference.js"
import { jsonObject, normalizeJson, readonlyCopy } from "../serialization.js"
import type {
  ActorIdentifier,
  AsyncInvocationOptions,
  DeepReadonly,
  DestroyOptions,
  InvocationOptions,
  JsonObject,
  JsonValue,
  MessageStatus,
  SnapshotOptions,
} from "../types.js"
import { consoleLogger } from "./configuration.js"
import {
  actorName,
  callHost,
  unwrapReply,
  type ActorIdentity,
  type DurableObjectsBackend,
  type HostRequest,
} from "./protocol.js"

export function createRuntime(options: { backend: DurableObjectsBackend }): CloudflareRuntime {
  return new CloudflareRuntime(options.backend)
}

export class CloudflareRuntime implements ActorRuntime {
  readonly settings = { logger: consoleLogger }
  readonly realtime = {
    connect: (): never =>
      unsupported("process-local realtime; use the session Durable Object WebSocket"),
  }
  readonly capabilities = Object.freeze({
    actors: true,
    realtime: true,
    sharedTransactions: false,
    fleetAdministration: false,
  })

  constructor(readonly backend: DurableObjectsBackend) {}

  ref<ActorType extends Actor>(
    actorClass: ActorClass<ActorType>,
    actorId: ActorIdentifier,
  ): ActorReference<ActorType> {
    const definition = validateDefinition(actorClass)
    return createActorReference({
      runtime: this,
      actorClass,
      actorType: definition.type,
      actorId: String(actorId),
      operations: new Set(definition.operations),
      queries: new Set(definition.queries),
    })
  }

  async invoke<Result = JsonValue>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue?: JsonObject
    options?: InvocationOptions
  }): Promise<DeepReadonly<Result>> {
    assertOutsideActor()
    const timeoutMilliseconds = timeout(options.options)
    const deadline = Date.now() + timeoutMilliseconds
    const message = await this.enqueue<Result>({
      reference: options.reference,
      operation: options.operation,
      argumentsValue: options.argumentsValue ?? {},
      options: options.options ?? {},
      deliveryMode: "sync",
      timeoutMilliseconds,
    })
    return this.wait(message, {
      ...options.options,
      timeoutMilliseconds: Math.max(0, deadline - Date.now()),
    })
  }

  async sendMessage<Result = JsonValue>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue?: JsonObject
    options?: AsyncInvocationOptions
  }): Promise<MessageReference<Result>> {
    assertOutsideActor()
    return this.enqueue({
      reference: options.reference,
      operation: options.operation,
      argumentsValue: options.argumentsValue ?? {},
      options: options.options ?? {},
      deliveryMode: "async",
      timeoutMilliseconds: 5_000,
    })
  }

  async lookupMessage<Result = JsonValue>(
    options: ActorIdentity & { requestId: string; authorizationContext?: JsonValue },
  ): Promise<MessageReference<Result> | undefined> {
    const value = await this.call({
      ...identity(options),
      method: "lookup",
      authorizationContext: context(options.authorizationContext),
      payload: { requestId: options.requestId },
    })
    return value === null ? undefined : this.reference<Result>(options, jsonObject(value))
  }

  async messageStatus(
    message: MessageReference,
    options: SnapshotOptions = {},
  ): Promise<MessageStatus> {
    const record = await this.readMessage(message, options)
    return record.status as MessageStatus
  }

  async messageResult<Result>(
    message: MessageReference<Result>,
    options: SnapshotOptions = {},
  ): Promise<DeepReadonly<Result> | undefined> {
    const record = await this.readMessage(message, options)
    return resultFromRecord<Result>(record)
  }

  async wait<Result>(
    message: MessageReference<Result>,
    options: InvocationOptions = {},
  ): Promise<DeepReadonly<Result>> {
    assertOutsideActor()
    const timeoutMilliseconds = timeout(options)
    const deadline = Date.now() + timeoutMilliseconds
    let record: JsonObject = { status: "unknown", operation: "unknown" }
    do {
      try {
        record = await beforeDeadline(
          this.readMessage(message, options),
          Math.max(0, deadline - Date.now()),
        )
      } catch (error) {
        if (!(error instanceof RpcDeadline)) throw error
        break
      }
      const result = resultFromRecord<Result>(record)
      if (record.status === "completed") return result as DeepReadonly<Result>
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)))
    } while (Date.now() < deadline)
    throw new SyncTimeout({
      messageReference: message,
      details: {
        ...identity(message),
        timeoutMilliseconds,
        operation: String(record.operation),
        messageId: message.id,
        requestId: message.requestId,
        sequence: message.sequence,
        status: String(record.status),
        waitingOn: "unknown",
        activation: { ownerId: null, generation: 0n, expiresAt: null, process: null },
        blocker: null,
      },
    })
  }

  async snapshot<ActorType extends Actor>(
    reference: ActorReferenceCore<ActorType>,
    options: SnapshotOptions = {},
  ): Promise<ActorSnapshot<ActorType>> {
    return (await this.snapshotWithIncarnation(reference, options)).snapshot
  }

  async snapshotWithIncarnation<ActorType extends Actor>(
    reference: ActorReferenceCore<ActorType>,
    options: SnapshotOptions = {},
  ) {
    const value = jsonObject(
      await this.call({
        ...identity(reference),
        method: "snapshot",
        authorizationContext: context(options.authorizationContext),
        payload: {},
      }),
    )
    return {
      snapshot: readonlyCopy(jsonObject(value.snapshot)) as ActorSnapshot<ActorType>,
      instanceId: String(value.instanceId),
      revision: String(value.revision),
      createdAtMs: Number(value.createdAtMs),
    }
  }

  async destroy(
    reference: ActorReferenceCore<Actor>,
    options: DestroyOptions = {},
  ): Promise<boolean> {
    assertOutsideActor()
    return (
      (await this.call({
        ...identity(reference),
        method: "destroy",
        authorizationContext: context(options.authorizationContext),
        payload: {},
      })) === true
    )
  }

  actorAdministration(options: ActorIdentity & { authorizationContext?: JsonValue }) {
    const call = (payload: JsonObject) =>
      this.call({
        ...identity(options),
        method: "administration",
        authorizationContext: context(options.authorizationContext),
        payload,
      })
    return {
      deadLetters: () => call({ action: "deadLetters" }),
      retryDeadLetter: (id: string) => call({ action: "retryDeadLetter", id }),
      reminders: () => call({ action: "reminders" }),
      resumeReminder: (request: { name: string; runAt?: Date }) =>
        call({
          action: "resumeReminder",
          name: request.name,
          runAt: request.runAt?.getTime() ?? Date.now(),
        }),
    }
  }

  async openWebSocket(options: { sessionId: string; expiresAt: Date }): Promise<Response> {
    if (!this.backend.sessions) return unsupported("realtime without a sessions binding")
    if (
      !Number.isFinite(options.expiresAt.getTime()) ||
      options.expiresAt.getTime() <= Date.now()
    ) {
      throw new TypeError("session expiry must be in the future")
    }
    const sessionName = crypto.randomUUID()
    return this.backend.sessions
      .getByName(sessionName)
      .fetch("https://solid-objects.internal/session", {
        headers: {
          Upgrade: "websocket",
          "X-Solid-Session-Name": sessionName,
          "X-Solid-Session-Id": options.sessionId,
          "X-Solid-Session-Expiry": String(options.expiresAt.getTime()),
        },
      })
  }

  install(): never {
    return unsupported("install; storage initializes inside each Durable Object")
  }
  run(): never {
    return unsupported("process workers; Durable Objects run on requests and alarms")
  }
  registerCommitAction(): never {
    return unsupported("commitAction and shared SQL transactions")
  }
  get repository(): never {
    return unsupported("the shared SQL repository")
  }
  get administration(): never {
    return unsupported("fleet administration; use actorAdministration")
  }
  get reconciliation(): never {
    return unsupported("fleet reconciliation")
  }
  get processes(): never {
    return unsupported("process administration")
  }
  get doctor(): never {
    return unsupported("SQL diagnostics")
  }
  get retention(): never {
    return unsupported("fleet retention; each object prunes its own records")
  }

  private async enqueue<Result>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue: JsonObject
    options: AsyncInvocationOptions
    deliveryMode: "sync" | "async"
    timeoutMilliseconds: number
  }): Promise<MessageReference<Result>> {
    const requestId = crypto.randomUUID()
    const availableAt = options.options.availableAt?.getTime() ?? Date.now()
    if (!Number.isFinite(availableAt)) throw new TypeError("availableAt must be a valid date")
    const request: HostRequest = {
      ...identity(options.reference),
      method: "enqueue",
      authorizationContext: context(options.options.authorizationContext),
      payload: {
        requestId,
        operation: options.operation,
        arguments: jsonObject(options.argumentsValue),
        deliveryMode: options.deliveryMode,
        idempotencyKey: options.options.idempotencyKey ?? null,
        availableAt,
      },
    }
    let reply
    try {
      reply = await beforeDeadline(
        this.backend.namespace.getByName(actorName(request)).request(request),
        options.timeoutMilliseconds,
      )
    } catch (error) {
      throw new EnqueueOutcomeUnknown({ ...identity(request), requestId }, { cause: error })
    }
    return this.reference<Result>(request, jsonObject(unwrapReply(reply)))
  }

  private reference<Result>(actor: ActorIdentity, value: JsonObject): MessageReference<Result> {
    return new MessageReference({
      runtime: this,
      ...identity(actor),
      id: String(value.id),
      requestId: String(value.requestId),
      sequence: BigInt(String(value.sequence)),
      operation: String(value.operation),
    })
  }

  private async readMessage(
    message: MessageReference,
    options: SnapshotOptions,
  ): Promise<JsonObject> {
    return jsonObject(
      await this.call({
        ...identity(message),
        method: "message",
        authorizationContext: context(options.authorizationContext),
        payload: {
          id: message.id,
          requestId: message.requestId,
          sequence: String(message.sequence),
        },
      }),
    )
  }

  private call(request: HostRequest): Promise<JsonValue> {
    return callHost({ backend: this.backend, request })
  }
}

function resultFromRecord<Result>(record: JsonObject): DeepReadonly<Result> | undefined {
  if (
    record.status === "ready" &&
    record.error &&
    jsonObject(record.error).name === "ActorSetupFailed"
  )
    throw new ActorSetupFailed(jsonObject(record.error).cause)
  if (record.status === "rejected") {
    const rejection = jsonObject(record.rejection)
    const error = new Rejected({
      code: String(rejection.code),
      message: String(rejection.message),
      details: jsonObject(rejection.details),
    })
    error.messageId = String(record.id)
    throw error
  }
  if (record.status === "dead")
    throw new MessageFailed({ messageId: String(record.id), details: jsonObject(record.error) })
  return record.status === "completed"
    ? (readonlyCopy(record.result) as DeepReadonly<Result>)
    : undefined
}

function assertOutsideActor(): void {
  if (currentActor())
    throw new ActorCallCycle("actors must use this.sendTo(reference) for transactional delivery")
}

function identity(value: ActorIdentity): ActorIdentity {
  return { actorType: value.actorType, actorId: String(value.actorId) }
}

function context<AuthorizationContext>(value: AuthorizationContext | undefined): JsonValue {
  return normalizeJson(value === undefined ? null : value)
}

function timeout(options: InvocationOptions = {}): number {
  const value = options.timeoutMilliseconds ?? 5_000
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError("timeoutMilliseconds must be a non-negative number")
  return value
}

function unsupported(capability: string): never {
  throw new UnsupportedCapability(`the Durable Objects backend does not support ${capability}`)
}

class RpcDeadline extends Error {}

export async function beforeDeadline<Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RpcDeadline()), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

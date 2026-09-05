import * as errors from "../errors.js"
import { jsonObject } from "../serialization.js"
import type { JsonObject, JsonValue } from "../types.js"

export interface ActorIdentity {
  actorType: string
  actorId: string
}

export interface HostRequest extends ActorIdentity {
  method:
    | "enqueue"
    | "internal"
    | "lookup"
    | "message"
    | "snapshot"
    | "destroy"
    | "subscribe"
    | "unsubscribe"
    | "projection"
    | "administration"
  authorizationContext: JsonValue
  payload: JsonObject
}

export type RpcReply =
  | { ok: true; value: JsonValue }
  | { ok: false; error: { name: string; message: string; details: JsonObject } }

export interface ActorHost {
  request(input: HostRequest): Promise<RpcReply>
}

export interface SessionHost {
  fetch(input: string, options: { headers: Record<string, string> }): Promise<Response>
  publish(options: { subscriptionId: string; event: JsonObject }): Promise<void>
}

export interface ActorNamespace {
  getByName(name: string): ActorHost
}

export interface SessionNamespace {
  getByName(name: string): SessionHost
}

export interface DurableObjectsBackend {
  readonly kind: "durable-objects"
  readonly namespace: ActorNamespace
  readonly sessions?: SessionNamespace
}

export function durableObjects(options: {
  namespace: ActorNamespace
  sessions?: SessionNamespace
}): DurableObjectsBackend {
  return Object.freeze({ kind: "durable-objects", ...options })
}

export function actorName(identity: ActorIdentity): string {
  return JSON.stringify([identity.actorType, String(identity.actorId)])
}

export function encodeError<ErrorValue>(error: ErrorValue): Extract<RpcReply, { ok: false }> {
  const details: JsonObject = {}
  if (error instanceof errors.Rejected) {
    details.code = error.code
    details.details = jsonObject(error.details)
    if (error.messageId !== undefined) details.messageId = error.messageId
  }
  if (error instanceof errors.MessageFailed) {
    details.messageId = error.messageId
    details.details = jsonObject(error.details)
  }
  return {
    ok: false,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "operation failed",
      details,
    },
  }
}

export function unwrapReply(reply: RpcReply): JsonValue {
  if (reply.ok) return reply.value
  const { name, message, details } = reply.error
  if (name === "Rejected") {
    const error = new errors.Rejected({
      code: String(details.code),
      message,
      details: jsonObject(details.details),
    })
    if (typeof details.messageId === "string") error.messageId = details.messageId
    throw error
  }
  if (name === "MessageFailed") {
    throw new errors.MessageFailed({
      messageId: String(details.messageId),
      details: jsonObject(details.details),
    })
  }
  const constructors: Record<string, new (message: string) => Error> = {
    Unauthorized: errors.Unauthorized,
    UnknownActorType: errors.UnknownActorType,
    UnknownOperation: errors.UnknownOperation,
    ActorDestroyed: errors.ActorDestroyed,
    ActorCallCycle: errors.ActorCallCycle,
    IdempotencyConflict: errors.IdempotencyConflict,
    MailboxFull: errors.MailboxFull,
    PayloadTooLarge: errors.PayloadTooLarge,
    InvalidPayload: errors.InvalidPayload,
    QueryMutatedState: errors.QueryMutatedState,
    ApplicationWriteForbidden: errors.ApplicationWriteForbidden,
    NonRetryableError: errors.NonRetryableError,
    UnsupportedCapability: errors.UnsupportedCapability,
    StateMigrationError: errors.StateMigrationError,
    UnknownDeadLetter: errors.UnknownDeadLetter,
    UnknownReminder: errors.UnknownReminder,
    ReminderNotPaused: errors.ReminderNotPaused,
    UnknownPayloadBroadcast: errors.UnknownPayloadBroadcast,
    TypeError,
  }
  const Constructor = constructors[name] ?? errors.SolidObjectsError
  throw new Constructor(message)
}

export async function callHost(options: {
  backend: DurableObjectsBackend
  request: HostRequest
}): Promise<JsonValue> {
  return unwrapReply(
    await options.backend.namespace.getByName(actorName(options.request)).request(options.request),
  )
}

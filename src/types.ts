export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type DeepReadonly<Value> = Value extends JsonPrimitive
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value

export type ActorIdentifier = string | number

export interface InvocationOptions<AuthorizationContext = unknown> {
  authorizationContext?: AuthorizationContext
  idempotencyKey?: string
  timeoutMilliseconds?: number
}

export interface AsyncInvocationOptions<AuthorizationContext = unknown> {
  authorizationContext?: AuthorizationContext
  idempotencyKey?: string
  availableAt?: Date
}

export interface DestroyOptions<AuthorizationContext = unknown> {
  authorizationContext?: AuthorizationContext
}

export interface SnapshotOptions<AuthorizationContext = unknown> {
  authorizationContext?: AuthorizationContext
}

export interface AdministrationOptions<AuthorizationContext = unknown> {
  authorizationContext?: AuthorizationContext
}

export interface MessageContext {
  id: string
  requestId: string
  actorType: string
  actorId: string
  sequence: bigint
  attempt: number
}

export interface EffectContext {
  id: string
  attempt: number
  actorType: string
  actorId: string
  messageId: string
}

export interface CommitActionContext {
  actorType: string
  actorId: string
  messageId: string
  requestId: string
  sequence: bigint
  connection: DatabaseConnection
}

export type MessageStatus = "ready" | "claimed" | "completed" | "rejected" | "dead" | "unknown"

export interface Logger {
  debug(entry: Record<string, unknown>): void
  info(entry: Record<string, unknown>): void
  warn(entry: Record<string, unknown>): void
  error(entry: Record<string, unknown>): void
}

export interface LongRunningComponent {
  run(signal: AbortSignal): Promise<void>
  requestShutdown(): void
  stopped(): boolean
  stop(): Promise<void> | void
}
import type { DatabaseConnection } from "./database/types.js"

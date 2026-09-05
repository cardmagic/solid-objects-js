import type { JsonObject, JsonValue, MessageStatus } from "../types.js"
import type { ActorIdentity } from "./protocol.js"

export interface Instance extends ActorIdentity {
  incarnation: string
  incarnationOrder: string
  generation: string
  revision: string
  nextSequence: string
  state: JsonObject
  stateVersion: number
  createdAt: number
  paused: boolean
}

export interface Message {
  id: string
  requestId: string
  incarnation: string
  sequence: string
  operation: string
  arguments: JsonObject
  deliveryMode: "sync" | "async" | "internal"
  idempotencyKey: string | null
  status: MessageStatus
  attempt: number
  availableAt: number
  createdAt: number
  completedAt: number | null
  result: JsonValue
  error: JsonObject | null
  rejection: { code: string; message: string; details: JsonObject } | null
  generation: string | null
  reminder: { name: string; generation: string } | null
}

export interface Outbox {
  id: string
  incarnation: string
  messageId: string
  kind: "effect" | "effect-callback" | "outbound" | "broadcast"
  destination: string
  sequence: string
  payload: JsonObject
  status: "pending" | "claimed" | "completed" | "dead"
  attempt: number
  availableAt: number
  completedAt: number | null
  error: JsonObject | null
}

export interface Reminder {
  name: string
  generation: string
  operation: string
  arguments: JsonObject
  at: number
  interval: number | null
  missed: "all" | "latest"
  status: "scheduled" | "paused" | "completed"
}

export interface Subscription {
  id: string
  sessionName: string
  payloads: string[]
  expiresAt: number
}

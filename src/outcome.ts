import type { DeepReadonly, JsonObject, JsonValue, MessageStatus } from "./types.js"

export interface ErrorRecord {
  readonly name: string
  readonly message: string
}

export interface RejectionRecord {
  readonly code: string
  readonly message: string
  readonly details: DeepReadonly<JsonObject>
}

export interface Outcome<Result = JsonValue> {
  readonly status: MessageStatus
  readonly result: DeepReadonly<Result> | undefined
  readonly error: ErrorRecord | undefined
  readonly rejection: RejectionRecord | undefined
  readonly attempts: number
}

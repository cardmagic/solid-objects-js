import type { JsonObject, JsonValue } from "./types.js"

export const EffectRecoveryOutcome = Object.freeze({
  Retired: "retired",
  Deferred: "deferred",
  Pending: "pending",
  Completed: "completed",
  Dead: "dead",
  AlreadyRetired: "alreadyRetired",
  Missing: "missing",
} as const)

export type EffectRecoveryOutcome =
  (typeof EffectRecoveryOutcome)[keyof typeof EffectRecoveryOutcome]

export type EffectRetiredPayload<Arguments extends JsonObject = JsonObject> = {
  effectId: string
  arguments: Arguments
  outcome: typeof EffectRecoveryOutcome.Retired
}

export type EffectRecoveryPayload<
  Arguments extends JsonObject = JsonObject,
  Result extends JsonValue = JsonValue,
> =
  | EffectRetiredPayload<Arguments>
  | {
      effectId: string
      arguments: Arguments
      outcome: typeof EffectRecoveryOutcome.Completed
      result: Result
    }
  | {
      effectId: string
      arguments?: Arguments
      outcome:
        | typeof EffectRecoveryOutcome.Deferred
        | typeof EffectRecoveryOutcome.Pending
        | typeof EffectRecoveryOutcome.Dead
        | typeof EffectRecoveryOutcome.AlreadyRetired
        | typeof EffectRecoveryOutcome.Missing
    }

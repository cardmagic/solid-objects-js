import type { EffectFailurePayload, EffectSuccessPayload, SerializedError } from "solid-objects"
import type { EffectFailurePayload as CoreFailurePayload } from "solid-objects/core"
import {
  Actor,
  EffectRecoveryOutcome,
  type EffectRecoveryPayload,
  type EffectRetiredPayload,
  type EffectHandle,
} from "solid-objects"

export function recoveryResult(
  payload: EffectRecoveryPayload<{ revision: number }, string>,
): string | null {
  if (payload.outcome === EffectRecoveryOutcome.Completed) return payload.result
  return null
}

export class ReportExport extends Actor {
  start(): EffectHandle {
    return this.emit("build_report", {
      onRecovery: "recover",
      recoveryTimeoutMilliseconds: 120_000,
    })
  }
  recover(payload: EffectRetiredPayload<{ revision: number }>): number {
    return payload.arguments.revision
  }
}

// @ts-expect-error Published retirement contracts require original arguments.
export const invalidRetirement: EffectRetiredPayload = { effectId: "id", outcome: "retired" }

type RunArguments = { generation: number }

export function failureGeneration(payload: EffectFailurePayload<RunArguments>): number {
  const corePayload: CoreFailurePayload<RunArguments> = payload
  const error: SerializedError = corePayload.error
  const message: string = error.message
  void message
  return corePayload.arguments.generation
}

export function successResult(payload: EffectSuccessPayload<RunArguments, string>): string {
  return payload.result
}

// @ts-expect-error Packaged declarations require the original arguments.
export const invalidFailure: EffectFailurePayload = {
  effectId: "id",
  error: { name: "Error", message: "failed" },
}

export const invalidArguments: EffectSuccessPayload<RunArguments> = {
  effectId: "id",
  // @ts-expect-error Packaged declarations retain application argument types.
  arguments: { generation: "wrong" },
  result: null,
}

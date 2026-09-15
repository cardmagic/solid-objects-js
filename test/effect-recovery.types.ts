import {
  Actor,
  EffectRecoveryOutcome,
  type EffectHandle,
  type EffectRecoveryPayload,
  type EffectRetiredPayload,
} from "../src/index.js"
import { EffectRecoveryOutcome as CoreOutcome } from "../src/core.js"
import { expectTypeOf } from "vitest"

class ReportExport extends Actor {
  start(): EffectHandle {
    const handle = this.emit("build_report", {
      onRecovery: "recover",
      onStatus: "inspect",
      recoveryTimeoutMilliseconds: 120_000,
    })
    this.requestEffectRecovery(handle)
    expectTypeOf(this.emit("plain")).toEqualTypeOf<EffectHandle>()
    // @ts-expect-error Recovery callbacks must name actor operations.
    this.emit("build_report", { onRecovery: "recvoer" })
    // @ts-expect-error Status callbacks must name actor operations.
    this.emit("build_report", { onStatus: "inspec" })
    // @ts-expect-error A handle requires its effect ID.
    this.requestEffectRecovery({})
    return handle
  }

  recover(payload: EffectRetiredPayload<{ revision: number }>): void {
    expectTypeOf(payload.outcome).toEqualTypeOf<"retired">()
    expectTypeOf(payload.arguments.revision).toEqualTypeOf<number>()
    // @ts-expect-error Retirement does not provide a success result.
    payload.result
  }

  inspect(payload: EffectRecoveryPayload<{ revision: number }, string | null>): void {
    switch (payload.outcome) {
      case EffectRecoveryOutcome.Completed:
        expectTypeOf(payload.result).toEqualTypeOf<string | null>()
        expectTypeOf(payload.arguments.revision).toEqualTypeOf<number>()
        return
      case EffectRecoveryOutcome.Retired:
        this.recover(payload)
        return
      case EffectRecoveryOutcome.Deferred:
      case EffectRecoveryOutcome.Pending:
      case EffectRecoveryOutcome.Dead:
      case EffectRecoveryOutcome.AlreadyRetired:
      case EffectRecoveryOutcome.Missing:
        // @ts-expect-error Noncompleted observations cannot provide a success result.
        payload.result
        return
      default:
        expectTypeOf(payload).toEqualTypeOf<never>()
    }
  }
}

expectTypeOf(CoreOutcome.Retired).toEqualTypeOf<"retired">()
// @ts-expect-error Retired payloads require original arguments.
export const invalidRetired: EffectRetiredPayload = { effectId: "id", outcome: "retired" }
// @ts-expect-error Completed observations require a result, including null.
export const invalidCompleted: EffectRecoveryPayload = {
  effectId: "id",
  outcome: "completed",
  arguments: {},
}
// @ts-expect-error The wire value is retired, never recovered.
export const invalidOutcome: EffectRecoveryPayload = { effectId: "id", outcome: "recovered" }
export { ReportExport }

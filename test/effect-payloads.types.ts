import { expectTypeOf } from "vitest"
import type {
  EffectFailurePayload,
  EffectSuccessPayload,
  JsonObject,
  JsonValue,
  SerializedError,
} from "../src/index.js"
import type {
  EffectFailurePayload as CoreFailurePayload,
  EffectSuccessPayload as CoreSuccessPayload,
  SerializedError as CoreSerializedError,
} from "../src/core.js"

type RunArguments = { generation: number }

export function checkEffectPayloads(
  failure: EffectFailurePayload<RunArguments>,
  success: EffectSuccessPayload<RunArguments, { reply: string }>,
): void {
  expectTypeOf(failure.arguments.generation).toEqualTypeOf<number>()
  expectTypeOf(failure.effectId).toEqualTypeOf<string>()
  expectTypeOf(failure.error).toEqualTypeOf<SerializedError>()
  expectTypeOf(failure.error.name).toEqualTypeOf<string>()
  expectTypeOf(failure.error.message).toEqualTypeOf<string>()
  expectTypeOf(success.result.reply).toEqualTypeOf<string>()
  expectTypeOf<EffectFailurePayload["arguments"]>().toEqualTypeOf<JsonObject>()
  expectTypeOf<EffectSuccessPayload["result"]>().toEqualTypeOf<JsonValue>()
  expectTypeOf<EffectFailurePayload>().toEqualTypeOf<CoreFailurePayload>()
  expectTypeOf<EffectSuccessPayload>().toEqualTypeOf<CoreSuccessPayload>()
  expectTypeOf<SerializedError>().toEqualTypeOf<CoreSerializedError>()

  const error: SerializedError = { name: "Error", message: "failed" }
  const argumentsValue = { generation: 1 }
  const failurePayload: EffectFailurePayload<RunArguments> = {
    effectId: "effect-1",
    arguments: argumentsValue,
    error,
  }
  const results: EffectSuccessPayload<RunArguments>[] = [null, false, 1, "reply", [], {}].map(
    (result) => ({ effectId: "effect-1", arguments: argumentsValue, result }),
  )
  void failurePayload
  void results

  // @ts-expect-error Original arguments are required.
  const missingArguments: EffectFailurePayload = { effectId: "effect-1", error }
  // @ts-expect-error Failure envelopes require the serialized error.
  const missingError: EffectFailurePayload = { effectId: "effect-1", arguments: {} }
  // @ts-expect-error Success envelopes require a result, including null for no return value.
  const missingResult: EffectSuccessPayload = { effectId: "effect-1", arguments: {} }
  // @ts-expect-error Error messages are strings.
  const wrongError: SerializedError = { name: "Error", message: 42 }
  // @ts-expect-error An effect ID is always present.
  const missingId: EffectFailurePayload = { arguments: {}, error }
  // @ts-expect-error Original arguments must be JSON-compatible.
  type InvalidArguments = EffectFailurePayload<{ generation: bigint }>
  // @ts-expect-error Results must be JSON-compatible.
  type InvalidResult = EffectSuccessPayload<RunArguments, undefined>
  // @ts-expect-error An application's declared generation remains numeric.
  failure.arguments.generation = "wrong"
  // @ts-expect-error An application's declared result remains typed.
  success.result.reply = 42
  void [missingArguments, missingError, missingResult, wrongError, missingId]
  expectTypeOf<InvalidArguments>().not.toBeNever()
  expectTypeOf<InvalidResult>().not.toBeNever()
}

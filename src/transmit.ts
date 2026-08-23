import { InvalidPayload, NonRetryableError } from "./errors.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import type { EffectContext, JsonObject, JsonValue } from "./types.js"

export { TRANSMIT_EFFECT } from "./transmit-effect.js"
import { TRANSMIT_EFFECT } from "./transmit-effect.js"

export interface TransmitEnvelope {
  effectId: string
  actorType: string
  actorId: string
  operation: string
  arguments: JsonObject
}

export interface RegisterTransmitOptions {
  runtime: SolidObjectsRuntime
  deliver: (envelope: TransmitEnvelope) => Promise<void>
  effectName?: string
}

export class InvalidTransmitEnvelope extends NonRetryableError {
  constructor(message: string) {
    super(message)
    this.name = "InvalidTransmitEnvelope"
  }
}

export function registerTransmit(options: RegisterTransmitOptions): void {
  const effectName = options.effectName ?? TRANSMIT_EFFECT
  options.runtime.registerEffect(effectName, async (argumentsValue, context) => {
    parseTransmitEnvelope({ argumentsValue, context })
    const undelivered = await undeliveredEnvelopesThrough({
      runtime: options.runtime,
      effectName,
      context,
    })
    for (const envelope of undelivered) await options.deliver(envelope)
    return null
  })
}

export async function receiveTransmitEnvelope(options: {
  runtime: SolidObjectsRuntime
  envelope: TransmitEnvelope
}): Promise<{ messageId: string }> {
  const { envelope } = options
  for (const field of ["effectId", "actorType", "actorId", "operation"] as const) {
    if (typeof envelope[field] !== "string" || envelope[field].length === 0) {
      throw new InvalidPayload(`transmit envelope requires a non-empty ${field}`)
    }
  }
  const argumentsValue = envelope.arguments ?? {}
  if (!isJsonObject(argumentsValue)) {
    throw new InvalidPayload("transmit envelope arguments must be a JSON object")
  }
  const message = await options.runtime.enqueueInternalMessage({
    actorType: envelope.actorType,
    actorId: envelope.actorId,
    operation: envelope.operation,
    argumentsValue,
    idempotencyKey: `transmit:${envelope.effectId}`,
  })
  return { messageId: message.id }
}

function parseTransmitEnvelope(input: {
  argumentsValue: JsonObject
  context: EffectContext
}): TransmitEnvelope {
  const { argumentsValue, context } = input
  const operation = argumentsValue.operation
  if (typeof operation !== "string" || operation.length === 0) {
    throw new InvalidTransmitEnvelope("transmit effect arguments require a non-empty operation")
  }
  const targetArguments = argumentsValue.arguments ?? {}
  if (!isJsonObject(targetArguments)) {
    throw new InvalidTransmitEnvelope(
      "transmit effect arguments must hold a JSON object in arguments",
    )
  }
  const actorType = argumentsValue.actorType ?? context.actorType
  const actorId = argumentsValue.actorId ?? context.actorId
  for (const [field, value] of [
    ["actorType", actorType],
    ["actorId", actorId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidTransmitEnvelope(`transmit effect ${field} must be a non-empty string`)
    }
  }
  return {
    effectId: context.id,
    actorType: actorType as string,
    actorId: actorId as string,
    operation,
    arguments: targetArguments,
  }
}

async function undeliveredEnvelopesThrough(input: {
  runtime: SolidObjectsRuntime
  effectName: string
  context: EffectContext
}): Promise<TransmitEnvelope[]> {
  const { runtime, effectName, context } = input
  const effects = runtime.repository.table("effects")
  const messages = runtime.repository.table("messages")
  const rows = await runtime.settings.database.connection((connection) =>
    connection.all<{ id: string; arguments: string }>(
      `SELECT effects.id, effects.arguments FROM ${effects} effects
       JOIN ${messages} messages ON messages.id = effects.message_id
       WHERE effects.name = ?
         AND effects.status IN ('pending', 'processing')
         AND messages.actor_type = ?
         AND messages.actor_id = ?
         AND messages.sequence <= (SELECT sequence FROM ${messages} WHERE id = ?)
       ORDER BY messages.sequence, effects.id`,
      [effectName, context.actorType, context.actorId, context.sourceMessageId],
    ),
  )
  const envelopes: TransmitEnvelope[] = []
  for (const row of rows) {
    const argumentsValue: JsonValue = JSON.parse(row.arguments)
    if (!isJsonObject(argumentsValue)) continue
    try {
      envelopes.push(
        parseTransmitEnvelope({
          argumentsValue,
          context: { ...context, id: row.id },
        }),
      )
    } catch (error) {
      if (!(error instanceof InvalidTransmitEnvelope)) throw error
    }
  }
  return envelopes
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

import { InvalidPayload, NonRetryableError } from "./errors.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import type { EffectContext, JsonObject } from "./types.js"

export const SYNC_BRIDGE_EFFECT = "solid-objects.sync"

export interface SyncEnvelope {
  effectId: string
  actorType: string
  actorId: string
  operation: string
  arguments: JsonObject
}

export interface SyncBridgeOptions {
  runtime: SolidObjectsRuntime
  transmit: (envelope: SyncEnvelope) => Promise<void>
  effectName?: string
}

export class InvalidSyncEnvelope extends NonRetryableError {
  constructor(message: string) {
    super(message)
    this.name = "InvalidSyncEnvelope"
  }
}

export function registerSyncBridge(options: SyncBridgeOptions): void {
  const effectName = options.effectName ?? SYNC_BRIDGE_EFFECT
  options.runtime.registerEffect(effectName, async (argumentsValue, context) => {
    parseSyncEnvelope({ argumentsValue, context })
    const undelivered = await undeliveredEnvelopesThrough({
      runtime: options.runtime,
      effectName,
      context,
    })
    for (const envelope of undelivered) await options.transmit(envelope)
    return null
  })
}

export async function receiveSyncEnvelope(options: {
  runtime: SolidObjectsRuntime
  envelope: SyncEnvelope
}): Promise<{ messageId: string }> {
  const { envelope } = options
  for (const field of ["effectId", "actorType", "actorId", "operation"] as const) {
    if (typeof envelope[field] !== "string" || envelope[field].length === 0) {
      throw new InvalidPayload(`sync envelope requires a non-empty ${field}`)
    }
  }
  if (!isJsonObject(envelope.arguments)) {
    throw new InvalidPayload("sync envelope arguments must be a JSON object")
  }
  const message = await options.runtime.enqueueInternalMessage({
    actorType: envelope.actorType,
    actorId: envelope.actorId,
    operation: envelope.operation,
    argumentsValue: envelope.arguments,
    idempotencyKey: `sync:${envelope.effectId}`,
  })
  return { messageId: message.id }
}

function parseSyncEnvelope(input: {
  argumentsValue: JsonObject
  context: EffectContext
}): SyncEnvelope {
  const { argumentsValue, context } = input
  const operation = argumentsValue.operation
  if (typeof operation !== "string" || operation.length === 0) {
    throw new InvalidSyncEnvelope("sync effect arguments require a non-empty operation")
  }
  const targetArguments = argumentsValue.arguments ?? {}
  if (!isJsonObject(targetArguments)) {
    throw new InvalidSyncEnvelope("sync effect arguments must hold a JSON object in arguments")
  }
  const actorType = argumentsValue.actorType ?? context.actorType
  const actorId = argumentsValue.actorId ?? context.actorId
  for (const [field, value] of [
    ["actorType", actorType],
    ["actorId", actorId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidSyncEnvelope(`sync effect ${field} must be a non-empty string`)
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
}): Promise<SyncEnvelope[]> {
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
  const envelopes: SyncEnvelope[] = []
  for (const row of rows) {
    try {
      envelopes.push(
        parseSyncEnvelope({
          argumentsValue: JSON.parse(row.arguments) as JsonObject,
          context: { ...context, id: row.id },
        }),
      )
    } catch (error) {
      if (!(error instanceof InvalidSyncEnvelope)) throw error
    }
  }
  return envelopes
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

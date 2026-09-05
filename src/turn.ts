import type { Actor, ObservableProjection } from "./actor.js"
import type { ActorRuntime } from "./actor-runtime.js"
import { withActorContext, withActorProjection } from "./context.js"
import { actorState, type ValidatedActorDefinition } from "./definition.js"
import { QueryMutatedState } from "./errors.js"
import { jsonObject, normalizeJson, stableJson } from "./serialization.js"
import type { JsonObject, MessageContext } from "./types.js"

export function readActorObservables(options: {
  actor: Actor
  definition: ValidatedActorDefinition
  runtime: ActorRuntime
  stateJson?: string
}): ObservableProjection {
  const { actor, definition, runtime } = options
  const before = options.stateJson ?? stableJson(actorState(actor, definition.stateKeys))
  const intentCount = actor.intentCount()
  const projection = withActorProjection({ actor, runtime }, () => actor.observableValues())
  if (
    stableJson(actorState(actor, definition.stateKeys)) !== before ||
    actor.intentCount() !== intentCount
  ) {
    throw new QueryMutatedState("observables must not mutate actor state or stage durable work")
  }
  return projection
}

export function selectActorBroadcast(
  projection: ObservableProjection,
  names: readonly string[] = Object.keys(projection.values),
): { observables: JsonObject; invalidations: string[] } {
  const observables: JsonObject = {}
  const invalidations: string[] = []
  for (const name of names) {
    if (projection.modes[name] === "invalidation") {
      invalidations.push(name)
      continue
    }
    const value = projection.values[name]
    if (value !== undefined) observables[name] = value
  }
  return { observables, invalidations }
}

export async function evaluateActorTurn(options: {
  actor: Actor
  definition: ValidatedActorDefinition
  runtime: ActorRuntime
  message: MessageContext
  operation: string
  argumentsValue: JsonObject
  stateBefore?: JsonObject
  maxStateBytes: number
  maxResultBytes: number
}) {
  const { actor, definition, runtime, operation } = options
  const before = stableJson(options.stateBefore ?? actorState(actor, definition.stateKeys))
  const previous = readActorObservables({ actor, definition, runtime, stateJson: before })
  const query = definition.queries.includes(operation)
  const rawResult = await withActorContext({ actor, runtime, message: options.message }, () =>
    actor.invoke(operation, options.argumentsValue),
  )
  const state = jsonObject(actorState(actor, definition.stateKeys), {
    maxBytes: options.maxStateBytes,
  })
  const stateJson = stableJson(state)
  if (query && stateJson !== before) {
    throw new QueryMutatedState(`query ${operation} mutated actor state`)
  }
  if (query && actor.hasIntents()) {
    throw new QueryMutatedState(`query ${operation} staged durable work`)
  }
  const result = normalizeJson(rawResult === undefined ? null : rawResult, {
    maxBytes: options.maxResultBytes,
  })
  const projection = readActorObservables({ actor, definition, runtime, stateJson })
  const changedNames = Object.keys(projection.values).filter(
    (name) =>
      stableJson(projection.values[name]) !== stableJson(previous.values[name]) ||
      projection.modes[name] !== previous.modes[name],
  )
  const broadcast =
    changedNames.length > 0 || (Object.keys(definition.payloads).length > 0 && stateJson !== before)
      ? selectActorBroadcast(projection, changedNames)
      : undefined
  return { state, stateJson, result, broadcast }
}

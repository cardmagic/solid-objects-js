import { Actor, type ActorClass } from "./actor.js"
import { withApplicationWritesForbidden } from "./context.js"
import { ApplicationWriteForbidden, InvalidActor, StateMigrationError } from "./errors.js"
import { deepCopy, jsonObject, normalizeJson } from "./serialization.js"
import type { JsonObject } from "./types.js"

export type PayloadBroadcastHandler = (
  actor: Actor,
  authorizationContext: unknown,
) => unknown | Promise<unknown>

export interface StateMigration {
  from: number
  to: number
  migrate(state: JsonObject): JsonObject
}

export interface ValidatedActorDefinition<ActorType extends Actor = Actor> {
  actorClass: ActorClass<ActorType>
  type: string
  stateKeys: readonly string[]
  operations: readonly string[]
  queries: readonly string[]
  stateVersion: number
  migrations: readonly StateMigration[]
  payloads: Readonly<Record<string, PayloadBroadcastHandler>>
}

export function validateDefinition<ActorType extends Actor>(
  actorClass: ActorClass<ActorType>,
): ValidatedActorDefinition<ActorType> {
  const type = actorClass.actorType
  if (!type || !/^[A-Za-z0-9_.:-]+$/.test(type)) {
    throw new InvalidActor(
      "actorType must contain letters, digits, dots, colons, underscores, or hyphens",
    )
  }

  const initialActor = new actorClass("__solid_objects_definition__")
  const state = actorState(initialActor)
  const stateKeys = Object.keys(state)
  const operations: string[] = []
  const queries = [...stateKeys]
  const reservedNames = actorPrototypeNames()
  const referenceNames = new Set([
    "actorClass",
    "actorId",
    "actorType",
    "destroy",
    "operations",
    "queries",
    "runtime",
    "send",
    "snapshot",
    "then",
    "with",
  ])

  let prototype: object | null = actorClass.prototype
  while (prototype && prototype !== Actor.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || reservedNames.has(name)) continue
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      if (!descriptor) continue
      validateOperationName(name)
      validateReferenceName(name, referenceNames)

      if (typeof descriptor.get === "function") {
        if (!queries.includes(name)) queries.push(name)
        continue
      }

      if (typeof descriptor.value === "function" && !operations.includes(name)) {
        operations.push(name)
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null
  }

  for (const stateKey of stateKeys) {
    validateOperationName(stateKey)
    validateReferenceName(stateKey, referenceNames)
    if (reservedNames.has(stateKey) || operations.includes(stateKey)) {
      throw new InvalidActor(`state field ${stateKey} conflicts with an actor operation`)
    }
  }

  const stateVersion = actorClass.stateVersion ?? 1
  if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) {
    throw new InvalidActor("stateVersion must be a positive safe integer")
  }

  const migrations = actorClass.migrations ?? []
  const migrationStarts = new Set<number>()
  for (const migration of migrations) {
    if (migration.to !== migration.from + 1) {
      throw new InvalidActor("state migrations must advance exactly one version")
    }
    if (migrationStarts.has(migration.from)) {
      throw new InvalidActor(`state migration from ${migration.from} is defined more than once`)
    }
    migrationStarts.add(migration.from)
  }

  const payloads = validatePayloads(actorClass)

  return Object.freeze({
    actorClass,
    type,
    stateKeys: Object.freeze(stateKeys),
    operations: Object.freeze(operations),
    queries: Object.freeze(queries),
    stateVersion,
    migrations: Object.freeze([...migrations]),
    payloads,
  })
}

const defaultStates = new WeakMap<ValidatedActorDefinition, string>()

/**
 * A constructor must not depend on external state, so one default image per
 * validated definition is correct. The cache holds the encoded image, so every
 * call parses a detached copy that a caller cannot use to reach the cache.
 */
export function initialStateFor(definition: ValidatedActorDefinition): JsonObject {
  const cached = defaultStates.get(definition)
  if (cached !== undefined) return JSON.parse(cached) as JsonObject

  const state = actorState(
    new definition.actorClass("__solid_objects_defaults__"),
    definition.stateKeys,
  )
  defaultStates.set(definition, JSON.stringify(state))
  return state
}

export function actorState(actor: Actor, stateKeys?: readonly string[]): JsonObject {
  const keys = stateKeys ?? Object.keys(actor)
  const state: Record<string, unknown> = {}
  for (const key of keys) state[key] = (actor as unknown as Record<string, unknown>)[key]
  return jsonObject(state)
}

export function hydrateActor<ActorType extends Actor>(options: {
  definition: ValidatedActorDefinition<ActorType>
  actorId: string
  state: JsonObject
}): ActorType {
  const { definition, actorId, state } = options
  const actor = new definition.actorClass(actorId)
  actor.prepare(new Set(definition.operations))
  const target = actor as unknown as Record<string, unknown>
  for (const key of definition.stateKeys) target[key] = deepCopy(state[key])
  return actor
}

export function migrateState(options: {
  definition: ValidatedActorDefinition
  storedVersion: number
  storedState: JsonObject
}): JsonObject {
  const { definition, storedVersion, storedState } = options
  if (storedVersion > definition.stateVersion) {
    throw new StateMigrationError(
      `stored state version ${storedVersion} is newer than code version ${definition.stateVersion}`,
    )
  }

  try {
    let state = deepCopy(storedState)
    let version = storedVersion
    while (version < definition.stateVersion) {
      const migration = definition.migrations.find((candidate) => candidate.from === version)
      if (!migration)
        throw new StateMigrationError(`missing state migration from version ${version}`)
      state = jsonObject(withApplicationWritesForbidden(() => migration.migrate(deepCopy(state))))
      version = migration.to
    }

    const defaults = initialStateFor(definition)
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in state)) state[key] = normalizeJson(value)
    }
    return state
  } catch (error) {
    if (error instanceof StateMigrationError || error instanceof ApplicationWriteForbidden) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new StateMigrationError(`state migration failed: ${message}`, { cause: error })
  }
}

function actorPrototypeNames(): Set<string> {
  const names = new Set<string>()
  let prototype: object | null = Actor.prototype
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) names.add(name)
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  return names
}

function validateOperationName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new InvalidActor(`invalid actor member name ${JSON.stringify(name)}`)
  }
}

function validateReferenceName(name: string, reservedNames: ReadonlySet<string>): void {
  if (reservedNames.has(name)) {
    throw new InvalidActor(`actor member ${JSON.stringify(name)} conflicts with the reference API`)
  }
}

function validatePayloads(
  actorClass: ActorClass,
): Readonly<Record<string, PayloadBroadcastHandler>> {
  const configured = actorClass.payloads ?? {}
  if (!isRecord(configured)) throw new InvalidActor("actor payloads must be an object")

  const payloads: Record<string, PayloadBroadcastHandler> = {}
  for (const [name, handler] of Object.entries(configured)) {
    validateOperationName(name)
    if (typeof handler !== "function") {
      throw new InvalidActor(`actor payload ${JSON.stringify(name)} must be a function`)
    }
    payloads[name] = handler as PayloadBroadcastHandler
  }
  return Object.freeze(payloads)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

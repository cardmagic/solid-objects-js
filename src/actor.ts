import { currentMessage, currentRuntime } from "./context.js"
import { getDefaultRuntime } from "./default-runtime.js"
import type { StateMigration } from "./definition.js"
import { InvalidRejectionCode, Rejected, UnknownOperation } from "./errors.js"
import {
  createStagedOperationMap,
  createStagedOperations,
  type ActorReference,
  type ScheduledOperations,
  type StagedOperations,
} from "./reference.js"
import { jsonObject, normalizeJson } from "./serialization.js"
import type { ActorIdentifier, JsonObject, JsonValue, MessageContext } from "./types.js"

const observableBroadcastMode = Symbol("solid-objects.observable-broadcast-mode")

export type ObservableBroadcast<Value> = Readonly<{
  value: Value
  [observableBroadcastMode]: "invalidation" | "value"
}>

export interface ObservableProjection {
  values: JsonObject
  modes: Readonly<Record<string, "invalidation" | "value">>
}

export function broadcastInvalidation<Value>(value: Value): ObservableBroadcast<Value> {
  return Object.freeze({ value, [observableBroadcastMode]: "invalidation" })
}

export function broadcastValue<Value>(value: Value): ObservableBroadcast<Value> {
  return Object.freeze({ value, [observableBroadcastMode]: "value" })
}

export type PayloadBroadcastValue = JsonObject | JsonValue[]

export type PayloadBroadcasts<ActorType extends Actor, AuthorizationContext> = Readonly<
  Record<
    string,
    (
      actor: ActorType,
      authorizationContext: AuthorizationContext,
    ) => PayloadBroadcastValue | Promise<PayloadBroadcastValue>
  >
>

export interface EffectIntent {
  name: string
  arguments: JsonObject
  successOperation?: string
  failureOperation?: string
}

export interface CommitActionIntent {
  name: string
  arguments: JsonObject
}

export interface ReminderIntent {
  /** Names the alarm. Without a key this is the operation. */
  name: string
  operation: string
  atMilliseconds: number
  arguments: JsonObject
  intervalMilliseconds?: number
  missedPolicy: "all" | "latest"
}

export interface OutboundMessageIntent {
  actorType: string
  actorId: string
  operation: string
  arguments: JsonObject
  availableAtMilliseconds?: number
  idempotencyKey?: string
}

export interface ActorIntents {
  effects: EffectIntent[]
  commitActions: CommitActionIntent[]
  reminders: ReminderIntent[]
  outboundMessages: OutboundMessageIntent[]
}

export interface ActorClass<ActorType extends Actor = Actor> {
  new (actorId?: string): ActorType
  readonly actorType: string
  readonly stateVersion?: number
  readonly migrations?: readonly StateMigration[]
  readonly payloads?: Readonly<Record<string, unknown>>
}

export interface ReminderOptions {
  at: Date
  everyMilliseconds?: number
  missed?: "all" | "latest"
  /**
   * Your own identifier for the item this alarm is waiting on. Give one when an
   * actor waits on several things at once, so each gets its own alarm.
   */
  key?: string | number
}

/**
 * The key becomes part of the reminder name, which the database holds alongside
 * the operation, so it is bounded here rather than failing on the insert once
 * the turn is already doing work.
 */
const REMINDER_KEY_LIMIT = 128

function validatedReminderKey(key: string | number | undefined): string | undefined {
  if (key === undefined) return undefined

  const reminderKey = String(key)
  if (reminderKey.length === 0) throw new TypeError("reminder key must not be empty")
  if (reminderKey.length > REMINDER_KEY_LIMIT) {
    throw new TypeError(`reminder key must be at most ${REMINDER_KEY_LIMIT} characters`)
  }

  return reminderKey
}

export interface OutboundMessageOptions {
  availableAt?: Date
  idempotencyKey?: string
}

export abstract class Actor {
  static readonly actorType: string
  static readonly stateVersion?: number
  static readonly migrations?: readonly StateMigration[]
  static readonly payloads: Readonly<Record<string, unknown>> = Object.freeze({})

  static ref<ActorType extends Actor>(
    this: new (actorId?: string) => ActorType,
    actorId: ActorIdentifier,
  ): ActorReference<ActorType> {
    return (currentRuntime() ?? getDefaultRuntime()).ref(this as ActorClass<ActorType>, actorId)
  }

  readonly #actorId: string
  readonly #intents: ActorIntents = {
    effects: [],
    commitActions: [],
    reminders: [],
    outboundMessages: [],
  }
  #operations: ReadonlySet<string> = new Set()

  constructor(actorId = "") {
    this.#actorId = actorId
  }

  get actorId(): string {
    return this.#actorId
  }

  get currentMessage(): MessageContext | undefined {
    return currentMessage()
  }

  observables(): Record<string, unknown> {
    return {}
  }

  async activate(): Promise<void> {
    await this.onActivate()
  }

  async deactivate(): Promise<void> {
    await this.onDeactivate()
  }

  protected onActivate(): void | Promise<void> {}

  protected onDeactivate(): void | Promise<void> {}

  reject(code: string, options: { message: string; details?: Record<string, unknown> }): never {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(code)) {
      throw new InvalidRejectionCode(
        `invalid rejection code ${JSON.stringify(code)}; expected a letter or underscore followed by letters, digits, or underscores`,
      )
    }
    throw new Rejected({
      code,
      message: options.message,
      ...(options.details === undefined ? {} : { details: options.details }),
    })
  }

  emit(
    name: string,
    options: {
      arguments?: Record<string, unknown>
      onSuccess?: string
      onFailure?: string
    } = {},
  ): void {
    for (const callback of [options.onSuccess, options.onFailure]) {
      if (callback !== undefined && !this.#operations.has(String(callback))) {
        throw new UnknownOperation(`unknown effect callback operation ${JSON.stringify(callback)}`)
      }
    }
    this.#intents.effects.push({
      name,
      arguments: jsonObject(options.arguments ?? {}),
      ...(options.onSuccess === undefined ? {} : { successOperation: String(options.onSuccess) }),
      ...(options.onFailure === undefined ? {} : { failureOperation: String(options.onFailure) }),
    })
  }

  commitAction(name: string, argumentsValue: Record<string, unknown> = {}): void {
    this.#intents.commitActions.push({ name, arguments: jsonObject(argumentsValue) })
  }

  /**
   * A reminder is one alarm per actor and name, and without a key that name is
   * the operation, so one actor holds one alarm per operation. A key names the
   * alarm for the item it is waiting on, which is what an actor holding a queue
   * of scheduled work needs; scheduling the same key again moves that item's
   * alarm and leaves the others alone.
   */
  schedule(options: ReminderOptions): ScheduledOperations {
    const atMilliseconds = options.at.getTime()
    if (!Number.isFinite(atMilliseconds)) throw new TypeError("reminder time must be valid")
    if (options.everyMilliseconds !== undefined && options.everyMilliseconds <= 0) {
      throw new TypeError("reminder interval must be positive")
    }
    const key = validatedReminderKey(options.key)

    return createStagedOperationMap(this.#operations, (operation, argumentsValue) => {
      this.#intents.reminders.push({
        name: key === undefined ? operation : `${operation}:${key}`,
        operation,
        atMilliseconds,
        arguments: jsonObject(argumentsValue),
        missedPolicy: options.missed ?? "latest",
        ...(options.everyMilliseconds === undefined
          ? {}
          : { intervalMilliseconds: options.everyMilliseconds }),
      })
    })
  }

  sendTo<TargetActor extends Actor>(
    reference: ActorReference<TargetActor>,
    options: OutboundMessageOptions = {},
  ): StagedOperations<TargetActor> {
    if (options.availableAt !== undefined && !Number.isFinite(options.availableAt.getTime())) {
      throw new TypeError("message availability time must be valid")
    }

    return createStagedOperations(reference.operations, (operation, argumentsValue) => {
      this.#intents.outboundMessages.push({
        actorType: reference.actorType,
        actorId: reference.actorId,
        operation,
        arguments: jsonObject(argumentsValue),
        ...(options.availableAt === undefined
          ? {}
          : { availableAtMilliseconds: options.availableAt.getTime() }),
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      })
    })
  }

  /** @internal */
  prepare(operations: ReadonlySet<string>): void {
    this.#operations = operations
  }

  /** @internal */
  invoke(operation: string, argumentsValue: JsonObject): unknown {
    const actorOperation = (this as unknown as Record<string, unknown>)[operation]
    if (typeof actorOperation === "function") return actorOperation.call(this, argumentsValue)
    return actorOperation
  }

  /** @internal */
  observableValues(): ObservableProjection {
    const values: JsonObject = {}
    const modes: Record<string, "invalidation" | "value"> = {}
    for (const [name, configured] of Object.entries(this.observables())) {
      if (
        typeof configured !== "object" ||
        configured === null ||
        !isObservableBroadcast(configured)
      ) {
        values[name] = normalizeJson(configured)
        modes[name] = "invalidation"
        continue
      }
      values[name] = normalizeJson(configured.value)
      modes[name] = configured[observableBroadcastMode]
    }
    return { values, modes: Object.freeze(modes) }
  }

  /** @internal */
  drainIntents(): ActorIntents {
    return {
      effects: this.#intents.effects.splice(0),
      commitActions: this.#intents.commitActions.splice(0),
      reminders: this.#intents.reminders.splice(0),
      outboundMessages: this.#intents.outboundMessages.splice(0),
    }
  }

  /** @internal */
  discardIntents(): void {
    this.drainIntents()
  }

  /** @internal */
  hasIntents(): boolean {
    return this.intentCount() > 0
  }

  /** @internal */
  intentCount(): number {
    return Object.values(this.#intents).reduce((count, intents) => count + intents.length, 0)
  }
}

function isObservableBroadcast(value: object): value is ObservableBroadcast<JsonValue> {
  return observableBroadcastMode in value
}

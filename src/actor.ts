import { currentMessage, currentRuntime } from "./context.js"
import { getDefaultRuntime } from "./default-runtime.js"
import type { StateMigration } from "./definition.js"
import { InvalidRejectionCode, Rejected, UnknownOperation } from "./errors.js"
import { TRANSMIT_EFFECT } from "./transmit-effect.js"
import { randomUUID } from "./platform/uuid.js"
import {
  createStagedOperationMap,
  createStagedOperations,
  type ActorReference,
  type ScheduledOperations,
  type ScheduledOperationsFor,
  type StagedOperations,
} from "./reference.js"
import { jsonObject, normalizeJson } from "./serialization.js"
import type {
  ActorIdentifier,
  EffectHandle,
  JsonObject,
  JsonValue,
  MessageContext,
} from "./types.js"

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
  id?: string
  name: string
  arguments: JsonObject
  successOperation?: string
  failureOperation?: string
  recoveryOperation?: string
  statusOperation?: string
  recoveryTimeoutMilliseconds?: number
}

export interface EffectOptions<
  Success extends string = string,
  Failure extends string = Success,
  Recovery extends string = string,
  Status extends string = string,
> {
  arguments?: Record<string, unknown>
  onSuccess?: Exclude<Success, keyof Actor | "onActivate" | "onDeactivate">
  onFailure?: Exclude<Failure, keyof Actor | "onActivate" | "onDeactivate">
  onRecovery?: Exclude<Recovery, keyof Actor | "onActivate" | "onDeactivate">
  onStatus?: Exclude<Status, keyof Actor | "onActivate" | "onDeactivate">
  recoveryTimeoutMilliseconds?: number
}

export interface EffectRecoveryIntent {
  effectId: string
  requestId: string
}

type CallbackActor<Callback extends string> = string extends Callback
  ? Actor
  : Actor & Record<Callback, (...argumentsValue: never[]) => void>

type InferredActor<Keys extends PropertyKey, ActorType> = Actor &
  Pick<
    ActorType,
    Extract<Exclude<Keys, keyof Actor | "onActivate" | "onDeactivate">, keyof ActorType>
  >

export interface CommitActionIntent {
  name: string
  arguments: JsonObject
}

export interface ReminderIntent {
  /** Without a key this is the operation. */
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
  effectRecoveries?: EffectRecoveryIntent[]
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
  /** Your own identifier for the item this alarm waits on, so each item gets one. */
  key?: string | number
}

/** MySQL holds the reminder name in a VARCHAR(255); the other families hold more. */
const REMINDER_NAME_LIMIT = 255
const REMINDER_KEY_SEPARATOR = ":"

function validatedReminderKey(key: string | number | undefined): string | undefined {
  if (key === undefined) return undefined

  const reminderKey = String(key)
  if (reminderKey.length === 0) throw new TypeError("reminder key must not be empty")

  return reminderKey
}

/**
 * The name is the operation, a colon, and the key. An operation cannot hold a
 * colon of its own, so a keyed name never collides with an unkeyed one.
 *
 * The length is checked on the composed name rather than the key alone, because
 * a long operation and a short key overflow the column just as easily as the
 * reverse, and it is refused here rather than at the insert, once the turn is
 * already doing work.
 */
function reminderName(operation: string, key: string | undefined): string {
  if (key === undefined) return operation

  const name = `${operation}${REMINDER_KEY_SEPARATOR}${key}`
  if (name.length > REMINDER_NAME_LIMIT) {
    throw new TypeError(
      `reminder name ${name.length} characters exceeds the ${REMINDER_NAME_LIMIT} the database holds`,
    )
  }

  return name
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

  emit<
    const Success extends string = never,
    const Failure extends string = never,
    const Recovery extends string = never,
    const Status extends string = never,
  >(
    this: CallbackActor<NoInfer<Success>> &
      CallbackActor<NoInfer<Failure>> &
      CallbackActor<NoInfer<Recovery>> &
      CallbackActor<NoInfer<Status>>,
    name: string,
    options: EffectOptions<Success, Failure, Recovery, Status> = {},
  ): EffectHandle {
    for (const callback of [
      options.onSuccess,
      options.onFailure,
      options.onRecovery,
      options.onStatus,
    ]) {
      if (callback !== undefined && !this.#operations.has(String(callback))) {
        throw new UnknownOperation(`unknown effect callback operation ${JSON.stringify(callback)}`)
      }
    }
    const timeout = options.recoveryTimeoutMilliseconds
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0))
      throw new TypeError("recoveryTimeoutMilliseconds must be a positive safe integer")
    if (timeout !== undefined && options.onRecovery === undefined)
      throw new TypeError("recoveryTimeoutMilliseconds requires onRecovery")
    const id = randomUUID()
    this.#intents.effects.push({
      id,
      name,
      arguments: jsonObject(options.arguments ?? {}),
      ...(options.onSuccess === undefined ? {} : { successOperation: String(options.onSuccess) }),
      ...(options.onFailure === undefined ? {} : { failureOperation: String(options.onFailure) }),
      ...(options.onRecovery === undefined
        ? {}
        : { recoveryOperation: String(options.onRecovery) }),
      ...(options.onStatus === undefined ? {} : { statusOperation: String(options.onStatus) }),
      ...(timeout === undefined ? {} : { recoveryTimeoutMilliseconds: timeout }),
    })
    return { id }
  }

  requestEffectRecovery(handle: EffectHandle): void {
    if (
      typeof handle !== "object" ||
      handle === null ||
      typeof handle.id !== "string" ||
      handle.id.length === 0
    ) {
      throw new TypeError("effect recovery requires an effect handle")
    }
    this.#intents.effectRecoveries ??= []
    this.#intents.effectRecoveries.push({ effectId: handle.id, requestId: randomUUID() })
  }

  transmit<Keys extends keyof this, ActorType>(
    this: Actor & Pick<this, Keys> & (Partial<ActorType> | NoInfer<this>),
  ): ScheduledOperationsFor<InferredActor<Keys, ActorType>>
  transmit(): ScheduledOperations {
    return createStagedOperationMap(this.#operations, (operation, argumentsValue) => {
      this.#intents.effects.push({
        name: TRANSMIT_EFFECT,
        arguments: jsonObject({ operation, arguments: argumentsValue }),
      })
    })
  }

  commitAction(name: string, argumentsValue: Record<string, unknown> = {}): void {
    this.#intents.commitActions.push({ name, arguments: jsonObject(argumentsValue) })
  }

  /** See docs/api.md for when to give a reminder a key. */
  schedule<Keys extends keyof this, ActorType>(
    this: Actor & Pick<this, Keys> & (Partial<ActorType> | NoInfer<this>),
    options: ReminderOptions,
  ): ScheduledOperationsFor<InferredActor<Keys, ActorType>>
  schedule(options: ReminderOptions): ScheduledOperations {
    const atMilliseconds = options.at.getTime()
    if (!Number.isFinite(atMilliseconds)) throw new TypeError("reminder time must be valid")
    if (options.everyMilliseconds !== undefined && options.everyMilliseconds <= 0) {
      throw new TypeError("reminder interval must be positive")
    }
    const key = validatedReminderKey(options.key)

    return createStagedOperationMap(this.#operations, (operation, argumentsValue) => {
      this.#intents.reminders.push({
        name: reminderName(operation, key),
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
      effectRecoveries: this.#intents.effectRecoveries?.splice(0) ?? [],
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

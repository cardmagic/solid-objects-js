import { currentMessage } from "./context.js"
import { getDefaultRuntime } from "./default-runtime.js"
import type { StateMigration } from "./definition.js"
import { Rejected, UnknownOperation } from "./errors.js"
import {
  createStagedOperationMap,
  createStagedOperations,
  type ActorReference,
  type ScheduledOperations,
  type StagedOperations,
} from "./reference.js"
import { jsonObject } from "./serialization.js"
import type { ActorIdentifier, JsonObject, MessageContext } from "./types.js"

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
}

export interface ReminderOptions {
  at: Date
  everyMilliseconds?: number
  missed?: "all" | "latest"
}

export interface OutboundMessageOptions {
  availableAt?: Date
  idempotencyKey?: string
}

export abstract class Actor {
  static readonly actorType: string
  static readonly stateVersion?: number
  static readonly migrations?: readonly StateMigration[]

  static ref<ActorType extends Actor>(
    this: new (actorId?: string) => ActorType,
    actorId: ActorIdentifier,
  ): ActorReference<ActorType> {
    return getDefaultRuntime().ref(this as ActorClass<ActorType>, actorId)
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

  reject(code: string, options: { message: string; details?: Record<string, unknown> }): never {
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      throw new TypeError("rejection code must contain lowercase letters, digits, and underscores")
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

  schedule(options: ReminderOptions): ScheduledOperations {
    const atMilliseconds = options.at.getTime()
    if (!Number.isFinite(atMilliseconds)) throw new TypeError("reminder time must be valid")
    if (options.everyMilliseconds !== undefined && options.everyMilliseconds <= 0) {
      throw new TypeError("reminder interval must be positive")
    }

    return createStagedOperationMap(this.#operations, (operation, argumentsValue) => {
      this.#intents.reminders.push({
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
  observableValues(): JsonObject {
    return jsonObject(this.observables())
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

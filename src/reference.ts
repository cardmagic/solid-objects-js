import type { Actor, ActorClass } from "./actor.js"
import { SyncInsideTransaction, UnknownOperation } from "./errors.js"
import type { ActorRuntime } from "./actor-runtime.js"
import type {
  AsyncInvocationOptions,
  DeepReadonly,
  DestroyOptions,
  InvocationOptions,
  JsonObject,
  JsonValue,
  MessageStatus,
  SnapshotOptions,
} from "./types.js"

type FunctionKeys<Value> = {
  [Key in keyof Value]-?: Value[Key] extends (...argumentsValue: any[]) => any ? Key : never
}[keyof Value]

type DataKeys<Value> = {
  [Key in keyof Value]-?: Value[Key] extends (...argumentsValue: any[]) => any ? never : Key
}[keyof Value]

export type ActorOperationNames<ActorType extends Actor> = Exclude<
  Extract<FunctionKeys<ActorType>, string>,
  Extract<keyof Actor, string>
>

export type ActorQueryNames<ActorType extends Actor> = Exclude<
  Extract<DataKeys<ActorType>, string>,
  Extract<keyof Actor, string>
>

export type ActorSnapshot<ActorType extends Actor> = {
  readonly [Key in ActorQueryNames<ActorType>]: DeepReadonly<Awaited<ActorType[Key]>>
}

type MethodResult<Method> = Method extends (...argumentsValue: any[]) => infer Result
  ? Awaited<Result>
  : never

type OperationArguments<Method> = Method extends (...argumentsValue: infer Arguments) => any
  ? Arguments extends []
    ? Arguments
    : Arguments extends [unknown?]
      ? Exclude<Arguments[0], undefined> extends readonly unknown[]
        ? never
        : Exclude<Arguments[0], undefined> extends object
          ? Arguments
          : never
      : never
  : never

type InvokedMethod<Method> = Method extends (...argumentsValue: any[]) => infer Result
  ? [OperationArguments<Method>] extends [never]
    ? never
    : (...argumentsValue: OperationArguments<Method>) => Promise<DeepReadonly<Awaited<Result>>>
  : never

type SentMethod<Method> = Method extends (...argumentsValue: any[]) => any
  ? [OperationArguments<Method>] extends [never]
    ? never
    : (
        ...argumentsValue: OperationArguments<Method>
      ) => Promise<MessageReference<MethodResult<Method>>>
  : never

type StagedMethod<Method> = Method extends (...argumentsValue: any[]) => any
  ? [OperationArguments<Method>] extends [never]
    ? never
    : (...argumentsValue: OperationArguments<Method>) => void
  : never

type DirectMessages<ActorType extends Actor> = {
  [Key in ActorOperationNames<ActorType>]: InvokedMethod<ActorType[Key]>
}

type DirectQueries<ActorType extends Actor> = {
  readonly [Key in ActorQueryNames<ActorType>]: Promise<DeepReadonly<Awaited<ActorType[Key]>>>
}

type SentMessages<ActorType extends Actor> = {
  [Key in ActorOperationNames<ActorType>]: SentMethod<ActorType[Key]>
}

export type StagedOperations<ActorType extends Actor> = {
  [
    Key in keyof ActorType as Key extends keyof Actor
      ? never
      : ActorType[Key] extends (...argumentsValue: any[]) => any
        ? Key
        : never
  ]: StagedMethod<ActorType[Key]>
}

export interface ScheduledOperations {
  [operation: string]: (argumentsValue?: Record<string, unknown>) => void
}

export type ActorReference<ActorType extends Actor> = ActorReferenceCore<ActorType> &
  DirectMessages<ActorType> &
  DirectQueries<ActorType>

export type ActorMessageSender<ActorType extends Actor> = ActorMessageSenderCore<ActorType> &
  SentMessages<ActorType>

export type ActorInvoker<ActorType extends Actor> = DirectMessages<ActorType> &
  DirectQueries<ActorType>

export class MessageReference<Result = unknown> {
  private readonly runtime: ActorRuntime
  private readonly databaseTransactionActive: () => boolean
  readonly id: string
  readonly requestId: string
  readonly actorType: string
  readonly actorId: string
  readonly sequence: bigint
  private readonly operation: string

  constructor(options: {
    runtime: ActorRuntime
    id: string
    requestId: string
    actorType: string
    actorId: string
    sequence: bigint
    operation?: string
    databaseTransactionActive?: () => boolean
  }) {
    this.runtime = options.runtime
    this.id = options.id
    this.requestId = options.requestId
    this.actorType = options.actorType
    this.actorId = options.actorId
    this.sequence = options.sequence
    this.operation = options.operation ?? "unknown"
    this.databaseTransactionActive = options.databaseTransactionActive ?? (() => false)
    Object.freeze(this)
  }

  status(options: SnapshotOptions = {}): Promise<MessageStatus> {
    return this.runtime.messageStatus(this, options)
  }

  result(options: SnapshotOptions = {}): Promise<DeepReadonly<Result> | undefined> {
    return this.runtime.messageResult<Result>(this, options)
  }

  wait(options: InvocationOptions = {}): Promise<DeepReadonly<Result>> {
    if (this.databaseTransactionActive()) {
      throw new SyncInsideTransaction({
        actorType: this.actorType,
        actorId: this.actorId,
        operation: this.operation,
      })
    }
    return this.runtime.wait(this, options)
  }
}

export class ActorMessageSenderCore<ActorType extends Actor> {
  constructor(private readonly reference: ActorReferenceCore<ActorType>) {}

  with(options: AsyncInvocationOptions): ActorMessageSender<ActorType> {
    return createMessageSender(this.reference, options)
  }
}

export interface LiveSignal<Value> {
  get(): Value
}

export type ActorLiveSignals<ActorType extends Actor> = {
  readonly snapshot: LiveSignal<ActorSnapshot<ActorType> | undefined>
  readonly payloads: {
    readonly [name: string]: LiveSignal<DeepReadonly<JsonValue> | undefined>
  }
} & {
  readonly [name: string]: LiveSignal<DeepReadonly<JsonValue> | undefined>
}

export type LiveSignalsFactory = (reference: ActorReferenceCore<Actor>) => object

let liveSignalsFactory: LiveSignalsFactory | undefined

export function installLiveSignals(factory: LiveSignalsFactory): void {
  liveSignalsFactory = factory
}

export class ActorReferenceCore<ActorType extends Actor> {
  readonly send: ActorMessageSender<ActorType>
  readonly runtime: ActorRuntime
  readonly actorClass: ActorClass<ActorType>
  readonly actorType: string
  readonly actorId: string
  readonly operations: ReadonlySet<string>
  readonly queries: ReadonlySet<string>

  constructor(options: {
    runtime: ActorRuntime
    actorClass: ActorClass<ActorType>
    actorType: string
    actorId: string
    operations: ReadonlySet<string>
    queries: ReadonlySet<string>
  }) {
    this.runtime = options.runtime
    this.actorClass = options.actorClass
    this.actorType = options.actorType
    this.actorId = options.actorId
    this.operations = options.operations
    this.queries = options.queries
    this.send = createMessageSender(this, {})
  }

  with(options: InvocationOptions): ActorInvoker<ActorType> {
    return createInvoker(this, options)
  }

  #live: object | undefined

  get live(): ActorLiveSignals<ActorType> {
    if (!liveSignalsFactory) {
      throw new Error(
        'ref.live is inactive; import "solid-objects/signals" once to enable live signals',
      )
    }
    this.#live ??= liveSignalsFactory(this as unknown as ActorReferenceCore<Actor>)
    return this.#live as ActorLiveSignals<ActorType>
  }

  snapshot(options: SnapshotOptions = {}): Promise<ActorSnapshot<ActorType>> {
    return this.runtime.snapshot(this, options) as Promise<ActorSnapshot<ActorType>>
  }

  destroy(options: DestroyOptions = {}): Promise<boolean> {
    return this.runtime.destroy(this, options)
  }
}

export function createActorReference<ActorType extends Actor>(options: {
  runtime: ActorRuntime
  actorClass: ActorClass<ActorType>
  actorType: string
  actorId: string
  operations: ReadonlySet<string>
  queries: ReadonlySet<string>
}): ActorReference<ActorType> {
  const reference = new ActorReferenceCore(options)
  return createReferenceProxy(reference, {})
}

export function createStagedOperations<ActorType extends Actor>(
  operations: ReadonlySet<string>,
  dispatch: (operation: string, argumentsValue: JsonObject) => void,
): StagedOperations<ActorType> {
  return createStagedOperationMap(operations, dispatch) as unknown as StagedOperations<ActorType>
}

export function createStagedOperationMap(
  operations: ReadonlySet<string>,
  dispatch: (operation: string, argumentsValue: JsonObject) => void,
): ScheduledOperations {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined
        assertOperation(operations, property)
        return (...argumentsValue: unknown[]) =>
          dispatch(property, operationArguments(argumentsValue))
      },
    },
  ) as ScheduledOperations
}

function createReferenceProxy<ActorType extends Actor>(
  reference: ActorReferenceCore<ActorType>,
  options: InvocationOptions,
): ActorReference<ActorType> {
  return new Proxy(reference, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property)
      if (target.operations.has(property)) {
        return (...argumentsValue: unknown[]) =>
          target.runtime.invoke({
            reference: target,
            operation: property,
            argumentsValue: operationArguments(argumentsValue),
            options,
          })
      }
      if (target.queries.has(property)) {
        return target.runtime.invoke({
          reference: target,
          operation: property,
          argumentsValue: {},
          options,
        })
      }
      return Reflect.get(target, property)
    },
  }) as ActorReference<ActorType>
}

function createInvoker<ActorType extends Actor>(
  reference: ActorReferenceCore<ActorType>,
  options: InvocationOptions,
): ActorInvoker<ActorType> {
  return createReferenceProxy(reference, options) as ActorInvoker<ActorType>
}

function createMessageSender<ActorType extends Actor>(
  reference: ActorReferenceCore<ActorType>,
  options: AsyncInvocationOptions,
): ActorMessageSender<ActorType> {
  const sender = new ActorMessageSenderCore(reference)
  return new Proxy(sender, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property)
      if (!reference.operations.has(property)) return Reflect.get(target, property)
      return (...argumentsValue: unknown[]) =>
        reference.runtime.sendMessage({
          reference,
          operation: property,
          argumentsValue: operationArguments(argumentsValue),
          options,
        })
    },
  }) as ActorMessageSender<ActorType>
}

function assertOperation(operations: ReadonlySet<string>, operation: string): void {
  if (!operations.has(operation)) {
    throw new UnknownOperation(`unknown operation ${JSON.stringify(operation)}`)
  }
}

function operationArguments(argumentsValue: readonly unknown[]): JsonObject {
  if (argumentsValue.length === 0) return {}
  if (argumentsValue.length > 1)
    throw new TypeError("actor operations accept at most one arguments object")
  const value = argumentsValue[0]
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError("actor operation arguments must be an object")
  return value as JsonObject
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

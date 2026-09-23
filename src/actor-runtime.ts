import type { RealtimeManager } from "./realtime.js"
import type { Actor, ActorClass } from "./actor.js"
import type {
  ActorReference,
  ActorReferenceCore,
  ActorSnapshot,
  MessageReference,
} from "./reference.js"
import type { Outcome } from "./outcome.js"
import type {
  ActorIdentifier,
  AdministrationOptions,
  AsyncInvocationOptions,
  DeepReadonly,
  DestroyOptions,
  InvocationOptions,
  JsonObject,
  JsonValue,
  Logger,
  MessageStatus,
  SnapshotOptions,
} from "./types.js"

export interface SnapshotWithIncarnation<ActorType extends Actor> {
  snapshot: ActorSnapshot<ActorType>
  instanceId: string
  revision: string
  createdAtMs: number
}

export interface ActorRuntime {
  ref<ActorType extends Actor>(
    actorClass: ActorClass<ActorType>,
    actorId: ActorIdentifier,
  ): ActorReference<ActorType>
  invoke<Result = JsonValue>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue?: JsonObject
    options?: InvocationOptions
  }): Promise<DeepReadonly<Result>>
  sendMessage<Result = JsonValue>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue?: JsonObject
    options?: AsyncInvocationOptions
  }): Promise<MessageReference<Result>>
  wait<Result>(
    reference: MessageReference<Result>,
    options?: InvocationOptions,
  ): Promise<DeepReadonly<Result>>
  messageStatus(reference: MessageReference, options?: SnapshotOptions): Promise<MessageStatus>
  messageOutcome<Result>(
    reference: MessageReference<Result>,
    options?: SnapshotOptions,
  ): Promise<Outcome<Result>>
  findBy(input: {
    reference?: ActorReferenceCore<Actor>
    requestId?: string
    idempotencyKey?: string
    authorizationContext?: AdministrationOptions["authorizationContext"]
  }): Promise<MessageReference | undefined>
  messageResult<Result>(
    reference: MessageReference<Result>,
    options?: SnapshotOptions,
  ): Promise<DeepReadonly<Result> | undefined>
  snapshot<ActorType extends Actor>(
    reference: ActorReferenceCore<ActorType>,
    options?: SnapshotOptions,
  ): Promise<ActorSnapshot<ActorType>>
  snapshotWithIncarnation<ActorType extends Actor>(
    reference: ActorReferenceCore<ActorType>,
    options?: SnapshotOptions,
  ): Promise<SnapshotWithIncarnation<ActorType>>
  destroy(reference: ActorReferenceCore<Actor>, options?: DestroyOptions): Promise<boolean>
  readonly settings: { readonly logger: Logger }
  readonly realtime: Pick<RealtimeManager, "connect">
}

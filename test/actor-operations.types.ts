import type { ReminderHandle } from "../src/types.js"
import { expectTypeOf } from "vitest"
import {
  Actor,
  type ActorReference,
  type ScheduledOperations,
  type ScheduledOperationsFor,
} from "../src/index.js"
import type { ScheduledOperationsFor as CoreScheduledOperationsFor } from "../src/core.js"
import { validateDefinition, type ValidatedActorDefinition } from "../src/definition.js"

class ParentRun extends Actor {
  recoverIfStuck({ generation }: { generation: number }) {
    return generation
  }
  inheritedWatchdog() {
    this.schedule({ at: new Date(0) }).recoverIfStuck({ generation: 1 })
  }
}

export class ChatRun extends ParentRun {
  static override actorType = "typed-chat"
  generation = 0
  #activation = 1
  override onActivate(): void {}
  tuple: [{ generation: number }] = [{ generation: 1 }]
  get status() {
    return "running"
  }
  private helper() {
    return this.#activation
  }
  optional(argumentsValue?: { generation: number }) {
    return argumentsValue?.generation
  }
  finish() {
    return this.helper()
  }
  failTurn({ error }: { error: { message: string } }) {
    return error.message
  }

  start() {
    const operations = this.schedule({ at: new Date(0), key: "watchdog" })
    expectTypeOf(operations.recoverIfStuck({ generation: 1 })).toEqualTypeOf<ReminderHandle>()
    operations.finish()
    operations.optional()
    operations.optional({ generation: 1 })
    expectTypeOf(this.transmit().recoverIfStuck({ generation: 1 })).toEqualTypeOf<void>()
    this.transmit().finish()
    this.transmit().optional()
    this.emit("run_model", { onSuccess: "finish", onFailure: "failTurn" })
    this.emit("other_effect")
    this.commitAction("global_commit_action")
    const dynamicCallback: string = "failTurn"
    this.emit("run_model", { onFailure: dynamicCallback })
    const dynamicActor: Actor = this
    const dynamicOperations: ScheduledOperations = dynamicActor.schedule({ at: new Date(0) })
    dynamicOperations[dynamicCallback]!({ generation: 1 })
    // @ts-expect-error misspelled operation
    operations.recoverIfStcuk({ generation: 1 })
    // @ts-expect-error required argument
    operations.recoverIfStuck()
    // @ts-expect-error wrong argument value
    operations.recoverIfStuck({ generation: "1" })
    // @ts-expect-error extra argument field
    operations.recoverIfStuck({ generation: 1, extra: true })
    // @ts-expect-error zero-argument operation
    operations.finish({ generation: 1 })
    // @ts-expect-error private methods are not operations
    operations.helper()
    // @ts-expect-error queries are not operations
    operations.status()
    // @ts-expect-error tuple state is not an operation
    operations.tuple({ generation: 1 })
    // @ts-expect-error infrastructure is not an operation
    operations.schedule({ at: new Date(0) })
    // @ts-expect-error public lifecycle overrides remain infrastructure
    operations.onActivate()
    // @ts-expect-error transmit typo
    this.transmit().recoverIfStcuk({ generation: 1 })
    // @ts-expect-error transmit arguments
    this.transmit().recoverIfStuck({ generation: "1" })
    // @ts-expect-error a dynamic success name does not widen failure literals
    this.emit("run_model", { onSuccess: dynamicCallback, onFailure: "failTrun" })
    // @ts-expect-error a dynamic failure name does not widen success literals
    this.emit("run_model", { onSuccess: "finsih", onFailure: dynamicCallback })
    // @ts-expect-error failure callback typo
    this.emit("run_model", { onFailure: "failTrun" })
    // @ts-expect-error success callback typo
    this.emit("run_model", { onSuccess: "finsih" })
    // @ts-expect-error query callback
    this.emit("run_model", { onFailure: "status" })
    // @ts-expect-error state callback
    this.emit("run_model", { onFailure: "generation" })
    // @ts-expect-error private callback
    this.emit("run_model", { onFailure: "helper" })
    // @ts-expect-error infrastructure callback
    this.emit("run_model", { onFailure: "schedule" })
    // @ts-expect-error public lifecycle overrides are not callbacks
    this.emit("run_model", { onFailure: "onActivate" })
  }
}

export function checkReferences(reference: ActorReference<ChatRun>, actor: ChatRun) {
  expectTypeOf(reference.recoverIfStuck({ generation: 1 })).toEqualTypeOf<Promise<number>>()
  expectTypeOf(reference.status).toEqualTypeOf<Promise<string>>()
  actor.sendTo(reference).recoverIfStuck({ generation: 1 })
  const scheduled: ScheduledOperationsFor<ChatRun> = actor.schedule({ at: new Date(0) })
  expectTypeOf(scheduled).toEqualTypeOf<CoreScheduledOperationsFor<ChatRun>>()
  const definition: ValidatedActorDefinition<Actor> = validateDefinition(ChatRun)
  return definition
}

export function genericActor<ActorType extends Actor>(actor: ActorType, callback: string) {
  actor.emit("dynamic_effect", { onFailure: callback })
  const operations: ScheduledOperations = actor.schedule({ at: new Date(0) })
  return operations
}

export class ExistingOverride extends Actor {
  override emit(name: string, options: { onFailure?: string } = {}) {
    return super.emit(name, options)
  }
  // @ts-expect-error broad legacy override cannot promise concrete operation keys
  override schedule(options: { at: Date }): ScheduledOperations {
    return super.schedule(options)
  }
}

export function scheduleConstrainedActor<
  ActorType extends Actor & { recoverIfStuck(argumentsValue: { generation: number }): void },
>(actor: ActorType): void {
  actor.schedule({ at: new Date(0) }).recoverIfStuck({ generation: 1 })
  // @ts-expect-error generic receiver retains its argument constraint
  actor.schedule({ at: new Date(0) }).recoverIfStuck({ generation: "1" })
}

import {
  Actor,
  type ActorReference,
  type ScheduledOperationsFor,
  type EffectOptions,
  type ReminderHandle,
} from "solid-objects"
import type { ScheduledOperationsFor as CoreScheduledOperationsFor } from "solid-objects/core"

class ParentRun extends Actor {
  recoverIfStuck({ generation }: { generation: number }): number {
    return generation
  }
}

export class ChatRun extends ParentRun {
  generation = 0
  #active = true
  private helper(): boolean {
    return this.#active
  }
  finish(): void {
    this.#active = this.helper()
  }
  optional(argumentsValue?: { generation: number }): void {
    this.generation = argumentsValue?.generation ?? 0
  }
  start(): void {
    const operations = this.schedule({ at: new Date(0), key: "watchdog" })
    const handle: ReminderHandle = operations.recoverIfStuck({ generation: 1 })
    this.unschedule(handle)
    this.unschedule("finish", { key: "watchdog" })
    this.unscheduleAll("finish")
    operations.finish()
    operations.optional()
    this.transmit().recoverIfStuck({ generation: 1 })
    this.emit("run_model", { onFailure: "finish" })
    // @ts-expect-error operation typo
    operations.recoverIfStcuk({ generation: 1 })
    // @ts-expect-error argument type
    operations.recoverIfStuck({ generation: "1" })
    // @ts-expect-error required argument
    operations.recoverIfStuck()
    // @ts-expect-error private method
    operations.helper()
    // @ts-expect-error callback typo
    this.emit("run_model", { onFailure: "finsih" })
    // @ts-expect-error infrastructure callback
    this.emit("run_model", { onSuccess: "schedule" })
  }
}

export function checkPublicTypes(actor: ChatRun, reference: ActorReference<ChatRun>) {
  const operations: ScheduledOperationsFor<ChatRun> = actor.schedule({ at: new Date(0) })
  const core: CoreScheduledOperationsFor<ChatRun> = operations
  const options: EffectOptions<"finish"> = { onSuccess: "finish" }
  actor.emit("run_model", options)
  actor.sendTo(reference).recoverIfStuck({ generation: 1 })
  return core
}

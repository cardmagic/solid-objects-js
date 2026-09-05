import { createContextStore } from "./platform/context-store.js"
import type { Actor } from "./actor.js"
import type { ActorRuntime } from "./actor-runtime.js"
import type { MessageContext } from "./types.js"

interface ExecutionContext {
  actor?: Actor
  runtime?: ActorRuntime
  message?: MessageContext
  applicationWritesForbidden?: true
}

interface ActorExecutionContext {
  actor: Actor
  runtime: ActorRuntime
  message?: MessageContext
}

const storage = createContextStore<ExecutionContext>()

export function currentActor(): Actor | undefined {
  return storage.getStore()?.actor
}

export function currentRuntime(): ActorRuntime | undefined {
  return storage.getStore()?.runtime
}

export function currentMessage(): MessageContext | undefined {
  return storage.getStore()?.message
}

export function applicationWritesForbidden(): boolean {
  return storage.getStore()?.applicationWritesForbidden === true
}

export function withActorContext<Result>(
  context: ActorExecutionContext,
  callback: () => Result,
): Result {
  return storage.run({ ...context, applicationWritesForbidden: true }, callback)
}

export function withActorProjection<Result>(
  context: { actor: Actor; runtime: ActorRuntime },
  callback: () => Result,
): Result {
  return storage.run({ ...context, applicationWritesForbidden: true }, callback)
}

export function withApplicationWritesForbidden<Result>(callback: () => Result): Result {
  return storage.run({ ...storage.getStore(), applicationWritesForbidden: true }, callback)
}

export function withRuntime<Result>(runtime: ActorRuntime, callback: () => Result): Result {
  return storage.run({ ...storage.getStore(), runtime }, callback)
}

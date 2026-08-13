import { AsyncLocalStorage } from "node:async_hooks"
import type { Actor } from "./actor.js"
import type { MessageContext } from "./types.js"

interface ExecutionContext {
  actor?: Actor
  message?: MessageContext
  applicationWritesForbidden?: true
}

interface ActorExecutionContext {
  actor: Actor
  message: MessageContext
}

const storage = new AsyncLocalStorage<ExecutionContext>()

export function currentActor(): Actor | undefined {
  return storage.getStore()?.actor
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

export function withActorProjection<Result>(actor: Actor, callback: () => Result): Result {
  return storage.run({ actor, applicationWritesForbidden: true }, callback)
}

export function withApplicationWritesForbidden<Result>(callback: () => Result): Result {
  return storage.run({ ...storage.getStore(), applicationWritesForbidden: true }, callback)
}

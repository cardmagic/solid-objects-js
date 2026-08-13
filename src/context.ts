import { AsyncLocalStorage } from "node:async_hooks"
import type { Actor } from "./actor.js"
import type { MessageContext } from "./types.js"

interface ExecutionContext {
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

export function withActorContext<Result>(
  context: ExecutionContext,
  callback: () => Result,
): Result {
  return storage.run(context, callback)
}

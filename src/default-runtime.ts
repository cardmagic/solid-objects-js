import type { ActorRuntime } from "./actor-runtime.js"

let runtime: ActorRuntime | undefined

export function setDefaultRuntime(value: ActorRuntime): void {
  runtime = value
}

export function getDefaultRuntime(): ActorRuntime {
  if (!runtime) throw new Error("SolidObjects.configure must be called before Actor.ref")
  return runtime
}

export function clearDefaultRuntime(value?: ActorRuntime): void {
  if (value === undefined || runtime === value) runtime = undefined
}

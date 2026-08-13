import type { SolidObjectsRuntime } from "./runtime.js"

let runtime: SolidObjectsRuntime | undefined

export function setDefaultRuntime(value: SolidObjectsRuntime): void {
  runtime = value
}

export function getDefaultRuntime(): SolidObjectsRuntime {
  if (!runtime) throw new Error("SolidObjects.configure must be called before Actor.ref")
  return runtime
}

export function clearDefaultRuntime(value?: SolidObjectsRuntime): void {
  if (value === undefined || runtime === value) runtime = undefined
}

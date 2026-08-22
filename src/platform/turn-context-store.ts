import type { ContextStore } from "./context-store.js"

export class TurnContextStore<Store> implements ContextStore<Store> {
  #current: Store | undefined

  run<Result>(store: Store, callback: () => Result): Result {
    const previous = this.#current
    this.#current = store
    let restoreSynchronously = true
    try {
      const result = callback()
      if (isThenable(result)) {
        restoreSynchronously = false
        return resolveThenRestore({
          result,
          restore: () => {
            this.#current = previous
          },
        }) as Result
      }
      return result
    } finally {
      if (restoreSynchronously) this.#current = previous
    }
  }

  getStore(): Store | undefined {
    return this.#current
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false
  if (typeof value !== "object" && typeof value !== "function") return false
  return typeof (value as { then?: unknown }).then === "function"
}

async function resolveThenRestore(options: {
  result: PromiseLike<unknown>
  restore: () => void
}): Promise<unknown> {
  try {
    return await options.result
  } finally {
    options.restore()
  }
}

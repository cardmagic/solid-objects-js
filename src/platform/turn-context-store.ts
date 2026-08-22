import type { ContextStore } from "./context-store.js"

export class TurnContextStore<Store> implements ContextStore<Store> {
  #current: Store | undefined

  run<Result>(store: Store, callback: () => Result): Result {
    const previous = this.#current
    this.#current = store
    try {
      return callback()
    } finally {
      this.#current = previous
    }
  }

  getStore(): Store | undefined {
    return this.#current
  }
}

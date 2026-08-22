export interface ContextStore<Store> {
  run<Result>(store: Store, callback: () => Result): Result
  getStore(): Store | undefined
}

export type ContextStoreFactory = () => ContextStore<unknown>

export class ContextStoreFactoryMissing extends Error {
  constructor() {
    super(
      "no context store factory is registered; " +
        "import a platform entry point before actor or database work starts",
    )
    this.name = "ContextStoreFactoryMissing"
  }
}

let registeredFactory: ContextStoreFactory | undefined

export function registerContextStoreFactory(factory: ContextStoreFactory): void {
  registeredFactory = factory
}

export function createContextStore<Store>(): ContextStore<Store> {
  let instance: ContextStore<Store> | undefined
  return {
    run<Result>(store: Store, callback: () => Result): Result {
      if (!instance) {
        if (!registeredFactory) throw new ContextStoreFactoryMissing()
        instance = registeredFactory() as ContextStore<Store>
      }
      return instance.run(store, callback)
    },
    getStore(): Store | undefined {
      return instance?.getStore()
    },
  }
}

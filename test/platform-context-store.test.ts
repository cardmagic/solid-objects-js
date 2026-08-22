import { describe, expect, it } from "vitest"
import {
  ContextStoreFactoryMissing,
  createContextStore,
  registerContextStoreFactory,
} from "../src/platform/context-store.js"
import { TurnContextStore } from "../src/platform/turn-context-store.js"

describe("context store registry", () => {
  it("returns undefined from getStore before any run", () => {
    const store = createContextStore<{ value: number }>()
    expect(store.getStore()).toBeUndefined()
  })

  it("throws a clear error when run executes without a registered factory", () => {
    const store = createContextStore<{ value: number }>()
    expect(() => store.run({ value: 1 }, () => "ignored")).toThrow(ContextStoreFactoryMissing)
  })

  it("uses the AsyncLocalStorage factory after the node platform module loads", async () => {
    await import("../src/platform/node.js")
    const store = createContextStore<{ value: number }>()
    const observed = await store.run({ value: 7 }, async () => {
      await Promise.resolve()
      return store.getStore()?.value
    })
    expect(observed).toBe(7)
    expect(store.getStore()).toBeUndefined()
  })

  it("keeps the AsyncLocalStorage store across interleaved async runs", async () => {
    await import("../src/platform/node.js")
    const store = createContextStore<{ value: number }>()
    const results = await Promise.all(
      [1, 2, 3].map((value) =>
        store.run({ value }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5 - value))
          return store.getStore()?.value
        }),
      ),
    )
    expect(results).toEqual([1, 2, 3])
  })

  it("lets a later registration replace the factory for new stores", async () => {
    registerContextStoreFactory(() => new TurnContextStore())
    const store = createContextStore<{ value: string }>()
    const observed = store.run({ value: "turn" }, () => store.getStore()?.value)
    expect(observed).toBe("turn")
  })
})

describe("turn context store", () => {
  it("scopes a synchronous run and restores the previous store", () => {
    const store = new TurnContextStore<{ value: number }>()
    const observed = store.run({ value: 1 }, () => {
      const outer = store.getStore()?.value
      const inner = store.run({ value: 2 }, () => store.getStore()?.value)
      const restored = store.getStore()?.value
      return { outer, inner, restored }
    })
    expect(observed).toEqual({ outer: 1, inner: 2, restored: 1 })
    expect(store.getStore()).toBeUndefined()
  })

  it("restores the previous store when the callback throws", () => {
    const store = new TurnContextStore<{ value: number }>()
    expect(() =>
      store.run({ value: 1 }, () => {
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(store.getStore()).toBeUndefined()
  })

  it("scopes only the synchronous part of an async callback", async () => {
    const store = new TurnContextStore<{ value: number }>()
    const observed = await store.run({ value: 4 }, async () => {
      const beforeAwait = store.getStore()?.value
      await Promise.resolve()
      const afterAwait = store.getStore()?.value
      return { beforeAwait, afterAwait }
    })
    expect(observed).toEqual({ beforeAwait: 4, afterAwait: undefined })
    expect(store.getStore()).toBeUndefined()
  })

  it("never leaks a store into tasks that interleave with an async callback", async () => {
    const store = new TurnContextStore<{ value: number }>()
    let releaseCallback = () => {}
    const held = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    const running = store.run({ value: 9 }, async () => {
      await held
    })
    const interleaved = await new Promise<number | undefined>((resolve) =>
      setTimeout(() => resolve(store.getStore()?.value), 1),
    )
    releaseCallback()
    await running
    expect(interleaved).toBeUndefined()
  })
})

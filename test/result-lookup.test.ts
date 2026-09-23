import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { MessagePruned, Rejected } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import type { JsonObject } from "../src/types.js"

class CartActor extends Actor {
  static override readonly actorType = "LookupCartActor"
  static fail = false

  items = 0

  checkout({ orderId }: { orderId: number }): { orderId: number } {
    if (CartActor.fail) throw new Error("payment declined")
    this.items += 1
    return { orderId }
  }

  rejectCheckout(): never {
    throw new Rejected({ code: "closed", message: "the cart is closed" })
  }

  get total(): number {
    return this.items
  }
}

let runtime: SolidObjectsRuntime | undefined
let seenOperations: { operation: string; argumentsValue: JsonObject }[] = []
let hooks: string[] = []

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  CartActor.fail = false
  seenOperations = []
  hooks = []
})

async function start(
  overrides: { retainedIdempotencyKeys?: number; retainedIdempotencyKeysBytes?: number } = {},
): Promise<SolidObjectsRuntime> {
  const created = configure({
    database: sqlite({ path: ":memory:" }),
    maxAttempts: 1,
    ...overrides,
    retryDelayMilliseconds: () => 0,
    authorizeMessage: ({ operation, arguments: argumentsValue }) => {
      hooks.push("message")
      seenOperations.push({ operation, argumentsValue })
      return true
    },
    authorizeQuery: () => {
      hooks.push("query")
      return true
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  })
  created.register(CartActor)
  await created.install()
  runtime = created
  return created
}

describe("result lookup", () => {
  it("finds a completed message by request id and reads its result", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 4210 })
    await active.worker().runUntilIdle()

    const found = await active.findBy({ requestId: original.requestId })

    expect(found?.id).toBe(original.id)
    expect(await found?.status()).toBe("completed")
  })

  it("finds a completed message by idempotency key on its reference", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    const original = await reference.send
      .with({ idempotencyKey: "checkout-7f3a" })
      .checkout({ orderId: 4210 })
    await active.worker().runUntilIdle()

    const found = await reference.findBy({ idempotencyKey: "checkout-7f3a" })

    expect(found?.id).toBe(original.id)
    expect(await found?.status()).toBe("completed")
  })

  it("the runtime and the reference find the same message", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "checkout-7f3a" }).checkout({ orderId: 1 })

    const throughReference = await reference.findBy({ idempotencyKey: "checkout-7f3a" })
    const throughRuntime = await active.findBy({
      reference,
      idempotencyKey: "checkout-7f3a",
    })

    expect(throughRuntime?.id).toBe(throughReference?.id)
  })

  it("finds a message that has not run yet", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 1 })

    const found = await active.findBy({ requestId: original.requestId })

    expect(await found?.status()).toBe("ready")
  })

  it("finds a dead message and reports its error and attempts", async () => {
    const active = await start()
    CartActor.fail = true
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 1 })
    await active.worker().runUntilIdle()

    const found = await active.findBy({ requestId: original.requestId })
    const outcome = await found!.outcome()

    expect(outcome.status).toBe("dead")
    expect(outcome.attempts).toBe(1)
    expect(outcome.error?.name).toBe("Error")
    expect(outcome.error?.message).toBe("payment declined")
    expect(outcome.result).toBeUndefined()
  })

  it("finds a rejected message and reports its rejection", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.rejectCheckout()
    await active.worker().runUntilIdle()

    const found = await active.findBy({ requestId: original.requestId })
    const outcome = await found!.outcome()

    expect(outcome.status).toBe("rejected")
    expect(outcome.rejection?.code).toBe("closed")
    expect(outcome.rejection?.message).toBe("the cart is closed")
  })

  it("reports a completed outcome with its result", async () => {
    const active = await start()
    const worker = active.worker()
    const running = worker.run(new AbortController().signal)
    const result = await active.ref(CartActor, "alice").checkout({ orderId: 9 })
    worker.requestShutdown()
    await running

    expect(result).toEqual({ orderId: 9 })
    const found = await active.findBy({ requestId: (await lastRequestId(active))! })
    const outcome = await found!.outcome()
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toEqual({ orderId: 9 })
    expect(outcome.error).toBeUndefined()
    expect(outcome.rejection).toBeUndefined()
  })

  it("reports the result of a message that was sent asynchronously", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 4210 })
    await active.worker().runUntilIdle()

    const found = await active.findBy({ requestId: original.requestId })
    const outcome = await found!.outcome()

    expect(outcome.status).toBe("completed")
    expect(outcome.result).toEqual({ orderId: 4210 })
  })

  it("returns undefined for an unknown request id and an unknown key", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.checkout({ orderId: 1 })

    expect(await active.findBy({ requestId: crypto.randomUUID() })).toBeUndefined()
    expect(await reference.findBy({ idempotencyKey: "never-used" })).toBeUndefined()
  })

  it("refuses a lookup that names no key", async () => {
    const active = await start()

    await expect(active.findBy({})).rejects.toThrow(/exactly one of/)
  })

  it("refuses a lookup that names both keys", async () => {
    const active = await start()

    await expect(active.findBy({ requestId: "one", idempotencyKey: "two" })).rejects.toThrow(
      /exactly one of/,
    )
  })

  it("refuses an idempotency key without a reference", async () => {
    const active = await start()

    await expect(active.findBy({ idempotencyKey: "checkout-7f3a" })).rejects.toThrow(
      /requires reference/,
    )
  })

  it("returns undefined to a caller that cannot read the message", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 1 })
    const refusing = configure({
      database: active.settings.database,
      authorizeMessage: () => false,
    })
    refusing.register(CartActor)

    expect(await refusing.findBy({ requestId: original.requestId })).toBeUndefined()
    expect(
      await refusing.ref(CartActor, "alice").findBy({ idempotencyKey: "never-used" }),
    ).toBeUndefined()
  })

  it("authorizes against the stored operation and arguments", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 4210 })
    seenOperations = []

    await active.findBy({ requestId: original.requestId })

    expect(seenOperations).toEqual([{ operation: "checkout", argumentsValue: { orderId: 4210 } }])
  })

  it("uses the query hook for a query message", async () => {
    const active = await start()
    const worker = active.worker()
    const running = worker.run(new AbortController().signal)
    await active.ref(CartActor, "alice").total
    worker.requestShutdown()
    await running
    const requestId = (await lastRequestId(active))!
    hooks = []

    await active.findBy({ requestId })

    expect(hooks).toEqual(["query"])
  })

  it("does not find a key that belongs to another actor", async () => {
    const active = await start()
    await active
      .ref(CartActor, "alice")
      .send.with({ idempotencyKey: "checkout-7f3a" })
      .checkout({ orderId: 1 })

    expect(
      await active.ref(CartActor, "bob").findBy({ idempotencyKey: "checkout-7f3a" }),
    ).toBeUndefined()
  })

  it("rebuilds a reference that can wait for its result", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "checkout-7f3a" }).checkout({ orderId: 4210 })
    const found = await reference.findBy({ idempotencyKey: "checkout-7f3a" })

    await active.worker().runUntilIdle()
    await found!.wait()

    expect(await found!.status()).toBe("completed")
    expect((await reference.snapshot()).items).toBe(1)
  })

  it("tells a pruned message from one that never existed", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "checkout-7f3a" }).checkout({ orderId: 1 })
    await active.worker().runUntilIdle()
    await deleteMessages(active)

    await expect(reference.findBy({ idempotencyKey: "checkout-7f3a" })).rejects.toThrow(
      MessagePruned,
    )
    expect(await reference.findBy({ idempotencyKey: "never-used" })).toBeUndefined()
  })

  it("names the key it remembers", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "checkout-7f3a" }).checkout({ orderId: 1 })
    await active.worker().runUntilIdle()
    await deleteMessages(active)

    const error = await reference
      .findBy({ idempotencyKey: "checkout-7f3a" })
      .catch((thrown) => thrown)

    expect(error).toBeInstanceOf(MessagePruned)
    expect((error as MessagePruned).idempotencyKey).toBe("checkout-7f3a")
  })

  it("does not tell a refused caller that a key was pruned", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "checkout-7f3a" }).checkout({ orderId: 1 })
    await active.worker().runUntilIdle()
    await deleteMessages(active)
    const refusing = configure({
      database: active.settings.database,
      authorizeQuery: () => false,
    })
    refusing.register(CartActor)

    expect(
      await refusing.ref(CartActor, "alice").findBy({ idempotencyKey: "checkout-7f3a" }),
    ).toBeUndefined()
  })

  it("remembers a key whose message was rejected", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "rejected-7f3a" }).rejectCheckout()
    await active.worker().runUntilIdle()
    await deleteMessages(active)

    await expect(reference.findBy({ idempotencyKey: "rejected-7f3a" })).rejects.toThrow(
      MessagePruned,
    )
  })

  it("remembers a key whose message died", async () => {
    const active = await start()
    CartActor.fail = true
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "dead-7f3a" }).checkout({ orderId: 1 })
    await active.worker().runUntilIdle()
    await deleteDeadLetters(active)
    await deleteMessages(active)

    await expect(reference.findBy({ idempotencyKey: "dead-7f3a" })).rejects.toThrow(MessagePruned)
  })

  it("bounds what an instance remembers", async () => {
    const active = await start({ retainedIdempotencyKeys: 3 })
    const reference = active.ref(CartActor, "alice")
    for (let index = 0; index < 5; index += 1) {
      await reference.send.with({ idempotencyKey: `key-${index}` }).checkout({ orderId: index })
    }
    await active.worker().runUntilIdle()
    await deleteMessages(active)

    expect(await reference.findBy({ idempotencyKey: "key-0" })).toBeUndefined()
    await expect(reference.findBy({ idempotencyKey: "key-4" })).rejects.toThrow(MessagePruned)
    expect(await rememberedKeys(active)).toEqual(["key-2", "key-3", "key-4"])
  })

  it("remembers every key of one activation pass", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "first" }).checkout({ orderId: 1 })
    await reference.send.with({ idempotencyKey: "second" }).checkout({ orderId: 2 })
    await active.worker().runUntilIdle()
    await deleteMessages(active)

    await expect(reference.findBy({ idempotencyKey: "first" })).rejects.toThrow(MessagePruned)
    await expect(reference.findBy({ idempotencyKey: "second" })).rejects.toThrow(MessagePruned)
  })

  it("bounds what an instance remembers by size", async () => {
    const active = await start({ retainedIdempotencyKeysBytes: 64 })
    const reference = active.ref(CartActor, "alice")
    const keys = [0, 1, 2].map((index) => `${index}-${"k".repeat(20)}`)
    for (const [index, key] of keys.entries()) {
      await reference.send.with({ idempotencyKey: key }).checkout({ orderId: index })
    }
    await active.worker().runUntilIdle()

    const remembered = await rememberedKeys(active)

    expect(remembered).toEqual(keys.slice(-2))
    expect(JSON.stringify(remembered).length).toBeLessThanOrEqual(64)
  })

  it("remembers nothing for a key larger than what it retains", async () => {
    const active = await start({ retainedIdempotencyKeysBytes: 16 })
    const reference = active.ref(CartActor, "alice")
    const key = "k".repeat(100)
    await reference.send.with({ idempotencyKey: key }).checkout({ orderId: 1 })
    await active.worker().runUntilIdle()
    await deleteMessages(active)

    expect(await rememberedKeys(active)).toEqual([])
    expect(await reference.findBy({ idempotencyKey: key })).toBeUndefined()
  })

  it("remembers a re-sent key once", async () => {
    const active = await start()
    const reference = active.ref(CartActor, "alice")
    await reference.send.with({ idempotencyKey: "first" }).checkout({ orderId: 1 })
    await reference.send.with({ idempotencyKey: "second" }).checkout({ orderId: 2 })
    await active.worker().runUntilIdle()
    await deleteMessages(active)
    await reference.send.with({ idempotencyKey: "first" }).checkout({ orderId: 3 })
    await active.worker().runUntilIdle()

    expect(await rememberedKeys(active)).toEqual(["second", "first"])
  })

  it("remembers nothing for a message that carried no key", async () => {
    const active = await start()
    await active.ref(CartActor, "alice").send.checkout({ orderId: 1 })
    await active.worker().runUntilIdle()

    expect(await rememberedKeys(active)).toEqual([])
  })

  it("keeps request ids unique across the table", async () => {
    const active = await start()
    const first = await active.ref(CartActor, "alice").send.checkout({ orderId: 1 })
    const second = await active.ref(CartActor, "bob").send.checkout({ orderId: 2 })

    await expect(
      active.settings.database.transaction((connection) =>
        connection.run(
          `UPDATE ${active.repository.table("messages")} SET request_id = ? WHERE id = ?`,
          [first.requestId, second.id],
        ),
      ),
    ).rejects.toThrow()
  })

  it("reports one snapshot for every outcome field", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 4210 })
    await active.worker().runUntilIdle()
    const found = await active.findBy({ requestId: original.requestId })
    active.repository.messageStatus = () => {
      throw new Error("outcome must not read the status separately")
    }

    const outcome = await found!.outcome()

    expect(outcome.status).toBe("completed")
    expect(outcome.result).toEqual({ orderId: 4210 })
  })

  it("propagates an authorization failure rather than reporting absence", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 1 })
    const failing = configure({
      database: active.settings.database,
      authorizeMessage: () => {
        throw new Error("authorization service is down")
      },
    })
    failing.register(CartActor)

    await expect(failing.findBy({ requestId: original.requestId })).rejects.toThrow(
      /authorization service is down/,
    )
  })
})

async function lastRequestId(active: SolidObjectsRuntime): Promise<string | undefined> {
  const row = await active.settings.database.connection((connection) =>
    connection.get<{ request_id: string }>(
      `SELECT request_id FROM ${active.repository.table("messages")}
       ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
    ),
  )
  return row?.request_id
}

async function deleteMessages(active: SolidObjectsRuntime): Promise<void> {
  await active.settings.database.transaction((connection) =>
    connection.run(`DELETE FROM ${active.repository.table("messages")}`),
  )
}

async function deleteDeadLetters(active: SolidObjectsRuntime): Promise<void> {
  await active.settings.database.transaction((connection) =>
    connection.run(`DELETE FROM ${active.repository.table("dead_letters")}`),
  )
}

async function rememberedKeys(active: SolidObjectsRuntime): Promise<string[]> {
  const row = await active.settings.database.connection((connection) =>
    connection.get<{ completed_idempotency_keys: string | null }>(
      `SELECT completed_idempotency_keys FROM ${active.repository.table("instances")}`,
    ),
  )
  return JSON.parse(row?.completed_idempotency_keys ?? "[]") as string[]
}

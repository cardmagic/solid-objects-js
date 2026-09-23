import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { Rejected } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"

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
let seenOperations: { operation: string; argumentsValue: unknown }[] = []
let hooks: string[] = []

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  CartActor.fail = false
  seenOperations = []
  hooks = []
})

async function start(): Promise<SolidObjectsRuntime> {
  const created = configure({
    database: sqlite({ path: ":memory:" }),
    maxAttempts: 1,
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

  it("keeps request ids unique across the table", async () => {
    const active = await start()
    const original = await active.ref(CartActor, "alice").send.checkout({ orderId: 1 })

    await expect(
      active.settings.database.transaction((connection) =>
        connection.run(
          `UPDATE ${active.repository.table("messages")} SET request_id = ? WHERE id = ?`,
          [original.requestId, "impossible"],
        ),
      ),
    ).resolves.toBeDefined()
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

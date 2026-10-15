import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SolidObjectsRuntime } from "../src/runtime.js"
import {
  cartRuntime,
  type Inventory,
  type PaymentProvider,
} from "../examples/compare/cart-runtime.js"
import { IDLE_MILLISECONDS, ShoppingCart } from "../examples/compare/shopping-cart.js"

let directory: string
const runtimes: SolidObjectsRuntime[] = []

class FakePayments implements PaymentProvider {
  readonly calls: string[] = []
  readonly charges = new Map<string, { paymentId: string; amountCents: number }>()
  loseNextResponse = false
  loseEveryResponse = false
  failWithoutCharging = false
  declineEveryCall = false

  async charge({
    idempotencyKey,
    amountCents,
  }: {
    idempotencyKey: string
    cartId: string
    amountCents: number
  }): Promise<{ status: "paid"; paymentId: string } | { status: "declined" }> {
    this.calls.push(idempotencyKey)
    if (this.failWithoutCharging) throw new Error("the provider did not answer")
    if (this.declineEveryCall) return { status: "declined" }
    const charge = this.charges.get(idempotencyKey) ?? {
      paymentId: `payment-${this.charges.size + 1}`,
      amountCents,
    }
    this.charges.set(idempotencyKey, charge)
    if (this.loseEveryResponse) throw new Error("the response was lost")
    if (this.loseNextResponse) {
      this.loseNextResponse = false
      throw new Error("the worker stopped before it recorded the result")
    }
    return { status: "paid", paymentId: charge.paymentId }
  }

  async lookup({
    idempotencyKey,
  }: {
    idempotencyKey: string
  }): Promise<{ status: "paid"; paymentId: string } | { status: "not_found" }> {
    const charge = this.charges.get(idempotencyKey)
    if (!charge) return { status: "not_found" }
    return { status: "paid", paymentId: charge.paymentId }
  }
}

class FakeInventory implements Inventory {
  readonly releases = new Map<string, Record<string, number>>()

  async release({
    idempotencyKey,
    items,
  }: {
    idempotencyKey: string
    cartId: string
    items: Record<string, number>
  }): Promise<void> {
    this.releases.set(idempotencyKey, items)
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "compare-cart-"))
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(directory, { recursive: true, force: true })
})

async function startRuntime({
  payments = new FakePayments(),
  inventory = new FakeInventory(),
}: {
  payments?: PaymentProvider
  inventory?: Inventory
} = {}): Promise<SolidObjectsRuntime> {
  const runtime = cartRuntime({
    path: join(directory, "carts.sqlite3"),
    payments,
    inventory,
    retryDelayMilliseconds: () => 0,
    maxAttempts: 2,
  })
  runtimes.push(runtime)
  await runtime.install()
  return runtime
}

async function stopRuntime(runtime: SolidObjectsRuntime): Promise<void> {
  await runtime.close()
  runtimes.splice(runtimes.indexOf(runtime), 1)
}

const asOwner = { authorizationContext: { userId: "ada" } }

describe("the ShoppingCart actor", () => {
  it("keeps every item when requests for one cart arrive at the same time", async () => {
    const runtime = await startRuntime()
    const cart = runtime.ref(ShoppingCart, "ada").with(asOwner)

    await Promise.all(
      Array.from({ length: 10 }, () => cart.addItem({ productId: "shirt", quantity: 1 })),
    )

    const snapshot = await runtime.ref(ShoppingCart, "ada").snapshot(asOwner)
    expect(snapshot.items).toEqual({ shirt: 10 })
  })

  it("charges once when the payment response is lost and the charge runs again", async () => {
    const payments = new FakePayments()
    const runtime = await startRuntime({ payments })
    const cart = runtime.ref(ShoppingCart, "ada").with(asOwner)
    await cart.addItem({ productId: "shirt", quantity: 1 })
    payments.loseNextResponse = true

    await cart.checkOut({ amountCents: 2_500 })
    await runtime.testing.drain({ roles: ["effects", "actors"] })
    await runtime.testing.drain({ roles: ["effects", "actors"] })

    expect(payments.calls).toHaveLength(2)
    expect(new Set(payments.calls).size).toBe(1)
    expect(payments.charges.size).toBe(1)
    const snapshot = await runtime.ref(ShoppingCart, "ada").snapshot(asOwner)
    expect(snapshot).toMatchObject({ status: "paid", paymentId: "payment-1" })
  })

  it("ignores a second checkout while the first one is in progress", async () => {
    const payments = new FakePayments()
    const runtime = await startRuntime({ payments })
    const cart = runtime.ref(ShoppingCart, "ada").with(asOwner)
    await cart.addItem({ productId: "shirt", quantity: 1 })

    await cart.checkOut({ amountCents: 2_500 })
    await cart.checkOut({ amountCents: 2_500 })
    await runtime.testing.drain({ roles: ["effects", "actors"] })

    expect(payments.charges.size).toBe(1)
  })

  it("opens the cart again when the card is declined", async () => {
    const payments = new FakePayments()
    payments.declineEveryCall = true
    const runtime = await startRuntime({ payments })
    const cart = runtime.ref(ShoppingCart, "ada").with(asOwner)
    await cart.addItem({ productId: "shirt", quantity: 1 })

    await cart.checkOut({ amountCents: 2_500 })
    await runtime.testing.drain({ roles: ["effects", "actors"] })

    const snapshot = await runtime.ref(ShoppingCart, "ada").snapshot(asOwner)
    expect(snapshot.status).toBe("open")
    await expect(cart.addItem({ productId: "socks", quantity: 1 })).resolves.toBeDefined()
  })

  it("checks the charge before it opens the cart when every payment response is lost", async () => {
    const payments = new FakePayments()
    payments.loseEveryResponse = true
    const runtime = await startRuntime({ payments })
    const cart = runtime.ref(ShoppingCart, "ada").with(asOwner)
    await cart.addItem({ productId: "shirt", quantity: 1 })

    await cart.checkOut({ amountCents: 2_500 })
    for (let pass = 0; pass < 4; pass += 1) {
      await runtime.testing.drain({ roles: ["effects", "actors"] })
    }
    await cart.checkOut({ amountCents: 2_500 })
    await runtime.testing.drain({ roles: ["effects", "actors"] })

    const snapshot = await runtime.ref(ShoppingCart, "ada").snapshot(asOwner)
    expect(snapshot).toMatchObject({ status: "paid", paymentId: "payment-1" })
    expect(payments.charges.size).toBe(1)
  })

  it("opens the cart again when the check finds no charge", async () => {
    const payments = new FakePayments()
    payments.failWithoutCharging = true
    const runtime = await startRuntime({ payments })
    const cart = runtime.ref(ShoppingCart, "ada").with(asOwner)
    await cart.addItem({ productId: "shirt", quantity: 1 })

    await cart.checkOut({ amountCents: 2_500 })
    for (let pass = 0; pass < 4; pass += 1) {
      await runtime.testing.drain({ roles: ["effects", "actors"] })
    }

    const snapshot = await runtime.ref(ShoppingCart, "ada").snapshot(asOwner)
    expect(snapshot.status).toBe("open")
    expect(payments.charges.size).toBe(0)
  })

  it("ignores a release reminder that was queued behind newer activity", async () => {
    const inventory = new FakeInventory()
    const runtime = await startRuntime({ inventory })
    await runtime
      .ref(ShoppingCart, "ada")
      .send.with({ ...asOwner, idempotencyKey: "late-add" })
      .addItem({ productId: "shirt", quantity: 1 })
    await runtime.testing.drain({ roles: ["actors"] })
    await runtime
      .ref(ShoppingCart, "ada")
      .send.with({ ...asOwner, idempotencyKey: "later-add" })
      .addItem({ productId: "socks", quantity: 1 })

    await runtime.testing.runDueReminders({
      now: new Date(Date.now() + IDLE_MILLISECONDS + 1_000),
    })
    await runtime.testing.drain({ roles: ["actors", "effects"] })

    const snapshot = await runtime.ref(ShoppingCart, "ada").snapshot(asOwner)
    expect(snapshot.status).toBe("open")
    expect(inventory.releases.size).toBe(0)
  })

  it("releases the reserved stock of an idle cart after a restart", async () => {
    const beforeRestart = await startRuntime()
    await beforeRestart
      .ref(ShoppingCart, "ada")
      .with(asOwner)
      .addItem({ productId: "shirt", quantity: 2 })
    await stopRuntime(beforeRestart)

    const inventory = new FakeInventory()
    const afterRestart = await startRuntime({ inventory })
    await afterRestart.testing.runDueReminders({
      now: new Date(Date.now() + IDLE_MILLISECONDS + 1_000),
    })
    await afterRestart.testing.drain({ roles: ["actors", "effects"] })

    const snapshot = await afterRestart.ref(ShoppingCart, "ada").snapshot(asOwner)
    expect(snapshot.status).toBe("released")
    expect([...inventory.releases.values()]).toEqual([{ shirt: 2 }])
    await expect(
      afterRestart.ref(ShoppingCart, "ada").with(asOwner).checkOut({ amountCents: 5_000 }),
    ).rejects.toMatchObject({ code: "cart_closed" })
  })
})

import { Actor, type EffectFailurePayload, type EffectSuccessPayload } from "solid-objects"

export const IDLE_MILLISECONDS = 30 * 60 * 1000

type ChargeArguments = { cartId: string; amountCents: number }
type ChargeResult = { paymentId: string }

export class ShoppingCart extends Actor {
  static override readonly actorType = "ShoppingCart"

  items: Record<string, number> = {}
  couponCode: string | null = null
  status: "open" | "paying" | "paid" | "released" = "open"
  paymentId: string | null = null

  addItem({ productId, quantity }: { productId: string; quantity: number }): {
    items: Record<string, number>
  } {
    this.#requireOpen()
    this.items = { ...this.items, [productId]: (this.items[productId] ?? 0) + quantity }
    this.#armIdleRelease()
    return { items: this.items }
  }

  applyCoupon({ code }: { code: string }): void {
    this.#requireOpen()
    this.couponCode = code
    this.#armIdleRelease()
  }

  checkOut({ amountCents }: { amountCents: number }): { status: string } {
    if (this.status === "paying" || this.status === "paid") return { status: this.status }
    this.#requireOpen()
    this.status = "paying"
    this.emit("charge_payment", {
      arguments: { cartId: this.actorId, amountCents },
      onSuccess: "paid",
      onFailure: "paymentFailed",
    })
    return { status: this.status }
  }

  paid({ result }: EffectSuccessPayload<ChargeArguments, ChargeResult>): void {
    this.status = "paid"
    this.paymentId = result.paymentId
  }

  paymentFailed(_payload: EffectFailurePayload<ChargeArguments>): void {
    this.status = "open"
    this.#armIdleRelease()
  }

  releaseIfIdle(): void {
    if (this.status !== "open") return
    this.status = "released"
    this.emit("release_stock", { arguments: { cartId: this.actorId, items: this.items } })
  }

  #requireOpen(): void {
    if (this.status !== "open") {
      this.reject("cart_closed", { message: `The cart is ${this.status}` })
    }
  }

  #armIdleRelease(): void {
    this.schedule({ at: new Date(Date.now() + IDLE_MILLISECONDS) }).releaseIfIdle()
  }
}

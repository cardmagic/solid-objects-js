import { Actor, type EffectFailurePayload, type EffectSuccessPayload } from "solid-objects"

export const IDLE_MILLISECONDS = 30 * 60 * 1000

type ChargeArguments = { cartId: string; amountCents: number }
type ChargeResult = { status: "paid"; paymentId: string } | { status: "declined" }
type CheckArguments = { paymentKey: string }
type CheckResult = { status: "paid"; paymentId: string } | { status: "not_found" }

export class ShoppingCart extends Actor {
  static override readonly actorType = "ShoppingCart"

  items: Record<string, number> = {}
  couponCode: string | null = null
  status: "open" | "paying" | "checking" | "paid" | "released" = "open"
  paymentId: string | null = null
  activity = 0

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
    if (this.status === "paying" || this.status === "checking" || this.status === "paid") {
      return { status: this.status }
    }
    this.#requireOpen()
    this.status = "paying"
    this.emit("charge_payment", {
      arguments: { cartId: this.actorId, amountCents },
      onSuccess: "paymentSettled",
      onFailure: "paymentUnknown",
    })
    return { status: this.status }
  }

  paymentSettled({ result }: EffectSuccessPayload<ChargeArguments, ChargeResult>): void {
    if (result.status === "paid") {
      this.#markPaid(result.paymentId)
      return
    }
    this.#reopen()
  }

  paymentUnknown({ effectId }: EffectFailurePayload<ChargeArguments>): void {
    this.status = "checking"
    this.emit("check_payment", {
      arguments: { paymentKey: effectId },
      onSuccess: "paymentChecked",
    })
  }

  paymentChecked({ result }: EffectSuccessPayload<CheckArguments, CheckResult>): void {
    if (result.status === "paid") {
      this.#markPaid(result.paymentId)
      return
    }
    this.#reopen()
  }

  releaseIfIdle({ activity }: { activity: number }): void {
    if (activity !== this.activity || this.status !== "open") return
    this.status = "released"
    this.emit("release_stock", { arguments: { cartId: this.actorId, items: this.items } })
  }

  #markPaid(paymentId: string): void {
    this.status = "paid"
    this.paymentId = paymentId
  }

  #reopen(): void {
    this.status = "open"
    this.#armIdleRelease()
  }

  #requireOpen(): void {
    if (this.status !== "open") {
      this.reject("cart_closed", { message: `The cart is ${this.status}` })
    }
  }

  #armIdleRelease(): void {
    this.activity += 1
    this.schedule({ at: new Date(Date.now() + IDLE_MILLISECONDS) }).releaseIfIdle({
      activity: this.activity,
    })
  }
}

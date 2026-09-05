import { Actor, broadcastValue } from "solid-objects/core"

interface CartItem {
  name: string
  priceCents: number
  quantity: number
}

export class ShoppingCart extends Actor {
  static override readonly actorType = "ShoppingCart"
  items: Record<string, CartItem> = {}

  addItem(input: { sku: string; name: string; priceCents: number; quantity?: number }): number {
    if (
      !input.sku ||
      !input.name ||
      !Number.isSafeInteger(input.priceCents) ||
      input.priceCents < 0
    )
      throw new TypeError("sku, name, and a non-negative integer priceCents are required")
    const quantity = input.quantity ?? 1
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
      throw new TypeError("quantity must be a positive safe integer")
    const existing = this.items[input.sku]
    const combinedQuantity = (existing?.quantity ?? 0) + quantity
    if (!Number.isSafeInteger(combinedQuantity))
      throw new TypeError("combined quantity must be a positive safe integer")
    this.items[input.sku] = {
      name: input.name,
      priceCents: input.priceCents,
      quantity: combinedQuantity,
    }
    return this.totalCents
  }

  removeItem(input: { sku: string }): void {
    delete this.items[input.sku]
  }

  clear(): void {
    this.items = {}
  }

  clearLater(): void {
    this.schedule({ at: new Date(Date.now() + 5_000), key: "clear" }).clear!()
  }

  get itemCount(): number {
    return Object.values(this.items).reduce((total, item) => total + item.quantity, 0)
  }

  get totalCents(): number {
    return Object.values(this.items).reduce(
      (total, item) => total + item.priceCents * item.quantity,
      0,
    )
  }

  override observables() {
    return {
      itemCount: broadcastValue(this.itemCount),
      totalCents: broadcastValue(this.totalCents),
    }
  }
}

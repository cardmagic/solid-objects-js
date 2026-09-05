import { describe, expect, it } from "vitest"
import { ShoppingCart } from "../../examples/cloudflare/shopping-cart.js"

describe("Cloudflare shopping-cart example", () => {
  it("rejects quantities that exceed JavaScript safe integer precision", () => {
    const cart = new ShoppingCart("precision")
    cart.addItem({ sku: "item", name: "Item", priceCents: 1, quantity: Number.MAX_SAFE_INTEGER })
    expect(() => cart.addItem({ sku: "item", name: "Item", priceCents: 1 })).toThrow(
      "combined quantity must be a positive safe integer",
    )
  })
})

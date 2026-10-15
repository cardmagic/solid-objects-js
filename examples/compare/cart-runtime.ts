import { createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { ShoppingCart } from "./shopping-cart.js"

export type PaymentProvider = {
  charge(options: {
    idempotencyKey: string
    cartId: string
    amountCents: number
  }): Promise<{ status: "paid"; paymentId: string } | { status: "declined" }>
  lookup(options: {
    idempotencyKey: string
  }): Promise<{ status: "paid"; paymentId: string } | { status: "not_found" }>
}

export type Inventory = {
  release(options: {
    idempotencyKey: string
    cartId: string
    items: Record<string, number>
  }): Promise<void>
}

const CALLER_OPERATIONS = new Set(["addItem", "applyCoupon", "checkOut"])

export function cartRuntime({
  path,
  payments,
  inventory,
  retryDelayMilliseconds,
  maxAttempts,
}: {
  path: string
  payments: PaymentProvider
  inventory: Inventory
  retryDelayMilliseconds?: (attempt: number) => number
  maxAttempts?: number
}): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path }),
    ...(retryDelayMilliseconds ? { retryDelayMilliseconds } : {}),
    ...(maxAttempts ? { maxAttempts } : {}),
    authorizeMessage: ({ actorType, actorId, operation, authorizationContext }) =>
      actorType === ShoppingCart.actorType &&
      CALLER_OPERATIONS.has(operation) &&
      ownsCart({ actorId, authorizationContext }),
    authorizeQuery: ({ actorType, actorId, authorizationContext }) =>
      actorType === ShoppingCart.actorType && ownsCart({ actorId, authorizationContext }),
  })
  runtime.register(ShoppingCart)
  runtime.registerEffect("charge_payment", (argumentsValue, context) =>
    payments.charge({
      idempotencyKey: context.id,
      cartId: String(argumentsValue.cartId),
      amountCents: Number(argumentsValue.amountCents),
    }),
  )
  runtime.registerEffect("check_payment", (argumentsValue) =>
    payments.lookup({ idempotencyKey: String(argumentsValue.paymentKey) }),
  )
  runtime.registerEffect("release_stock", (argumentsValue, context) =>
    inventory.release({
      idempotencyKey: context.id,
      cartId: String(argumentsValue.cartId),
      items: argumentsValue.items as Record<string, number>,
    }),
  )
  return runtime
}

function ownsCart({
  actorId,
  authorizationContext,
}: {
  actorId: string
  authorizationContext: unknown
}): boolean {
  if (typeof authorizationContext !== "object" || authorizationContext === null) return false
  return "userId" in authorizationContext && authorizationContext.userId === actorId
}

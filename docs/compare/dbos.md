# DBOS Transact and Solid Objects: durable checkout and state for each cart on PostgreSQL

DBOS Transact is a TypeScript library that checkpoints workflows and steps in a PostgreSQL system database. It has no object with its own state for each key. Its docs recommend "storing long-lived objects directly in your database" and using partitioned queues for concurrency and order. Solid Objects (the `solid-objects` npm package) gives each key, for example each shopping cart, an actor with an ordered mailbox, durable state, and reminders, in the SQLite, PostgreSQL, or MySQL database that the app already uses. Choose DBOS when the work is a workflow of steps that must not repeat after they complete. Choose Solid Objects when one thing has state that many requests change in order, and that thing must wake up later.

Solid Objects is an independent project. It is not affiliated with DBOS.

## The short answer

| Question                   | DBOS Transact                                                                                                                                  | Solid Objects                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What has state             | A workflow and its steps. Long-lived state goes in your own tables                                                                             | An actor class and an actor ID                                                                                                                         |
| One at a time for each key | A partitioned queue with `partitionConcurrency: 1`                                                                                             | One turn at a time for each actor                                                                                                                      |
| Order                      | "Queued tasks are started in first-in, first-out (FIFO) order." The docs call each partition a "subqueue"                                      | Messages run in the order that the runtime stores them                                                                                                 |
| Side effects               | "Steps are tried _at least once_ but are never re-executed after they complete"                                                                | Effects run at least once with a stable effect ID. A callback updates the state                                                                        |
| Idempotency                | "An assigned workflow ID acts as an idempotency key"                                                                                           | An idempotency key on each message, and the effect ID for each external call                                                                           |
| Later work                 | `DBOS.sleep` in a workflow, `delaySeconds` on enqueue, or `Debouncer`                                                                          | `this.schedule({ at, key }).operation(input)`                                                                                                          |
| Database                   | PostgreSQL                                                                                                                                     | SQLite, PostgreSQL, MySQL                                                                                                                              |
| What you run               | The library in your process and a PostgreSQL system database. For more than one process, see the note below                                    | The library in your process. A process calls `runtime.run(signal)`                                                                                     |
| New code and old work      | A workflow continues only on "the same application version that started the workflow", unless you turn on patching or set `applicationVersion` | Stored messages and reminders run on the code that is deployed when they run. Your [state migrations](../state-and-lifecycle.md) must accept old state |
| Node.js                    | Node.js 20 or newer                                                                                                                            | Node.js 24.4 or newer                                                                                                                                  |
| Licence                    | Transact: MIT. Self-hosted Conductor: proprietary. Hosted Conductor: from $99 a month                                                          | MIT. The optional Solid Objects Pro package is commercial                                                                                              |

The DBOS facts come from the [DBOS documentation](https://docs.dbos.dev) and the [DBOS pricing page](https://www.dbos.dev/dbos-pricing) (checked October 15, 2026).

Two DBOS pages differ on more than one process. The FAQ says "Conductor is required for correct workflow recovery in applications that use more than one process". The recovery page describes recovery without Conductor: each process has an executor ID, and a restarted process recovers its own pending workflows.

## Choose DBOS when

- The work is a sequence of steps, and a completed step must not run again after a crash.
- You want a workflow ID as the idempotency key for the whole sequence.
- You want a workflow dashboard and managed recovery from Conductor.
- An agent loop waits for days for a person, with `recv` and `setEvent`.

## Choose Solid Objects when

- One thing, such as a cart, has state that many requests change, and the requests must apply in order.
- The idle timer must move in the same transaction as the state change, for example to release stock after 30 minutes with no activity.
- You want the state change and its effects and reminders to commit in one SQL transaction.
- You use SQLite or MySQL, or you do not want DBOS system tables in PostgreSQL.

## The same terms in each

| DBOS Transact                       | Solid Objects                                |
| ----------------------------------- | -------------------------------------------- |
| Partition key (`queuePartitionKey`) | Actor ID                                     |
| Workflow function                   | Actor method (an operation)                  |
| Step (`DBOS.runStep`)               | Effect (`emit` and `runtime.registerEffect`) |
| Workflow ID as idempotency key      | `idempotencyKey` on `send.with(...)`         |
| `DBOS.sleep` or `delaySeconds`      | `schedule({ at, key })` and an operation     |
| `DBOS.send` and `DBOS.recv`         | A message to the actor                       |
| `DBOS.setEvent` and `DBOS.getEvent` | Actor queries and `snapshot()`               |
| Datasource transaction              | `commitAction`                               |

## A shopping cart checkout in each

The task: a Node.js TypeScript API runs as four processes behind a load balancer, with PostgreSQL. Each shopping cart can get concurrent requests (add item, apply coupon, check out) on different processes. Checkout calls a payment provider that sometimes times out, so a crash in the middle of checkout must recover without charging twice. Carts with no activity for 30 minutes must release their reserved stock, even across restarts.

### With DBOS Transact

This code is shortened from a design that follows the DBOS documentation. It was not compiled or run. `lockCart`, `markPaid`, `reserveItem`, and `releaseIfIdleInSql` are DBOS datasource transactions (`runTransaction`) on your own tables. Each one commits with its DBOS checkpoint, so it runs once.

```typescript
import { DBOS } from "@dbos-inc/dbos-sdk"

const cartQueue = (cartId: string, delaySeconds?: number) => ({
  queueName: "carts",
  enqueueOptions: { queuePartitionKey: cartId, delaySeconds },
})

const releaseIfIdle = DBOS.registerWorkflow(
  (cartId: string, version: number) => releaseIfIdleInSql(cartId, version),
  { name: "releaseIfIdle" },
)

const addItem = DBOS.registerWorkflow(
  async (cartId: string, sku: string) => {
    const version = await reserveItem(cartId, sku)
    await DBOS.startWorkflow(releaseIfIdle, cartQueue(cartId, 30 * 60))(cartId, version)
  },
  { name: "addItem" },
)

const checkout = DBOS.registerWorkflow(
  async (cartId: string) => {
    const cart = await lockCart(cartId)
    if (!cart) return "not-open"
    const charge = await DBOS.runStep(
      () =>
        payments.charge({
          cartId,
          amountCents: cart.totalCents,
          idempotencyKey: `${DBOS.workflowID}-charge`,
        }),
      { name: "charge", retriesAllowed: true, maxAttempts: 5, timeoutMS: 15_000 },
    )
    await markPaid(cartId, charge.id)
    return "paid"
  },
  { name: "checkout" },
)

await DBOS.registerQueue("carts", { partitionConcurrency: 1, workerConcurrency: 50 })

await DBOS.startWorkflow(checkout, {
  workflowID: `checkout-${requestIdempotencyKey}`,
  ...cartQueue(cartId),
})(cartId)
```

What this code gets from DBOS:

- The partitioned queue runs one workflow at a time for each cart.
- The workflow ID stops a second checkout with the same request key.
- A charge step that completed does not run again after a crash.
- The delayed `releaseIfIdle` workflow is stored in PostgreSQL and runs after a restart. The version check in SQL skips it if the cart changed.

What to know:

- A crash after the payment provider charges and before DBOS records the step makes the step run again. The provider must deduplicate the idempotency key. DBOS says that steps "should be **idempotent**".
- The cart state lives in your own tables. Each workflow reads and writes them in datasource transactions.
- A queued workflow starts only when a process polls the queue, at least 1,000 milliseconds apart by default. A request that waits for the result waits for that poll.
- DBOS also documents a `Debouncer`, which can replace the delayed `releaseIfIdle` workflow.

### With Solid Objects

There is one `ShoppingCart` actor for each cart ID.

```typescript
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
```

The runtime registers the actor and the two effects:

```typescript
import { createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { ShoppingCart } from "./shopping-cart.js"

export type PaymentProvider = {
  charge(options: {
    idempotencyKey: string
    cartId: string
    amountCents: number
  }): Promise<{ paymentId: string }>
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
```

Each process sends calls to the cart with the reference:

```typescript
await runtime
  .ref(ShoppingCart, cartId)
  .with({ authorizationContext: { userId } })
  .checkOut({ amountCents: totalFromYourPriceTable })
```

At least one process calls `runtime.run(signal)`. It runs the effects and the reminders.

How it works:

- Calls for one cart run one at a time on any of the four processes. Each call reads the state that the previous call committed, so no item is lost.
- Each change moves the one `releaseIfIdle` reminder 30 minutes ahead. The reminder is a row in the database, so it runs after a restart. When it runs, it releases the stock only if the cart is still open.
- `checkOut` sets the status to `paying` and stages the `charge_payment` effect in the same transaction. A second `checkOut` while the payment runs changes nothing.
- The effect handler uses `context.id` as the idempotency key. If the payment response is lost, the runtime runs the effect again with the same ID, and the provider charges once.
- If every attempt fails, `paymentFailed` opens the cart again and arms the reminder again.
- Compute the amount on the server from your own prices. Do not take it from the browser.

### What the tests prove

[The tests](../../test/compare-shopping-cart.test.ts) show these results:

- Ten concurrent `addItem` calls for one cart keep all ten items.
- When the payment response is lost, the effect runs again with the same idempotency key, and the provider charges once.
- A second checkout while the first one runs does not charge again.
- When every payment attempt fails, the cart opens again.
- After a restart, an idle cart releases its reserved stock and refuses a checkout.

## Questions that teams ask

**Is Solid Objects mature enough?** Here are the facts:

- First public release of the npm package: August 13, 2026.
- Version 1.0.0: October 13, 2026. The public API follows [semantic versioning](../versioning.md).
- One maintainer.
- One first-party application with more than 100,000 users runs it in production. That is a count of users, not a measure of load. No production use by other people is known.
- The [benchmarks](../benchmarks.md) are development measurements. Longer soak tests are open work.

DBOS has a company, a hosted service, and a longer history. If those matter more than state for each cart, choose DBOS.

**Why Node.js 24.4 or newer?** The SQLite adapter reads integer columns as `BigInt`. Node.js 24.4.0 is the first release that accepts `readBigInts` on the built-in SQLite module. See [support](../support.md).

**Does it need another process?** No new server. A process of your app calls `runtime.run(signal)`. While no process runs, pending work stays in SQL.

**Is delivery exactly once?** No. Delivery is at least once. Use the effect ID as the idempotency key for each external call. See [correctness](../correctness.md) and [effect recovery](../effect-recovery.md).

**Can I use both?** Yes. Code in a DBOS step can call an actor, and an actor effect handler can call any API.

## Sources

Checked October 15, 2026:

- [DBOS workflows and steps](https://docs.dbos.dev/typescript/reference/workflows-steps)
- [DBOS workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)
- [DBOS queue tutorial](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)
- [DBOS queue reference](https://docs.dbos.dev/typescript/reference/queues)
- [DBOS architecture](https://docs.dbos.dev/architecture)
- [DBOS datasource transactions](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)
- [DBOS FAQ](https://docs.dbos.dev/faq)
- [DBOS workflow recovery](https://docs.dbos.dev/production/workflow-recovery)
- [DBOS upgrading workflows](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows)
- [Migrating from Temporal to DBOS](https://docs.dbos.dev/explanations/migrating-from-temporal)
- [DBOS pricing](https://www.dbos.dev/dbos-pricing)

## More information

- [All comparisons](../comparisons.md)
- [Restate virtual objects and Solid Objects](restate.md)
- [Virtual actors in TypeScript](../virtual-actors.md)
- [Guide for coding agents](../agents.md)

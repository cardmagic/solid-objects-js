# Solid Objects for coding agents (TypeScript and Node.js)

This guide is for a coding agent that evaluates or adds Solid Objects in a
TypeScript or Node.js application. It gives the facts and steps in a fixed
order. Each step links to the maintained documentation for more detail.

## 1. Check the fit first

Use Solid Objects only if you can answer yes to most of these questions:

1. Does one identity, such as a room, cart, account, device, or document, own
   the state?
2. Must writes for that identity happen one at a time across requests and
   processes?
3. Must some work happen later or continue after a process exits?
4. Is the state a bounded JSON document, not a large relational dataset?
5. Can the application run `runtime.run(signal)` in at least one process for
   reminders, effects, and realtime delivery?

Select a simpler tool in these cases:

| Requirement                                    | Use instead                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The invariant fits in one request              | A transaction, a constraint, or `SELECT ... FOR UPDATE`                                                     |
| CPU-intensive or parallel work                 | `worker_threads` or a worker pool. An actor serializes work                                                 |
| Thousands of writes for each second to one key | A counter column or a cache. Solid Objects Pro covers this case for Rails; its Node build is in development |
| One atomic change across two actor identities  | One SQL transaction on normal tables                                                                        |
| Exactly-once calls to an external API          | Not available from any actor library. Use provider idempotency keys                                         |
| Replay of named workflow steps from a step log | A durable execution engine, such as DBOS or Temporal                                                        |

The full list is in [Choosing Solid Objects](fit.md). The category guide is
[Virtual actors in TypeScript and Node.js](virtual-actors.md).

## 2. Package identity

| Item               | Value                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| npm package        | `solid-objects`                                                                                       |
| Repository         | <https://github.com/cardmagic/solid-objects-js>                                                       |
| Website            | <https://solidobjects.dev/js>                                                                         |
| Ruby on Rails gem  | `solid_objects`, a separate implementation of the same model                                          |
| Commercial package | `@solidobjects/pro`, a separate paid package in development. The open-source package does not need it |

Solid Objects is not SolidJS and has no relation to it. It is not affiliated
with Cloudflare.

## 3. Requirements

- Node.js 24.4 or newer. Prefer 24.15 or newer, where `node:sqlite` is no
  longer experimental.
- The package is ESM only. TypeScript applications need TypeScript 5.9 or
  newer.
- SQLite through the `node:sqlite` module, PostgreSQL 14 or newer with the
  `pg` package, or MySQL 8.0 or newer with InnoDB and the `mysql2` package.
- Redis is optional. It only shortens wake-up latency and holds no durable
  state.

[Supported versions](support.md) lists the CI matrix.

## 4. Install

```bash
npm install solid-objects
npx solid-objects quickstart --yes
```

The quickstart runs 25 concurrent calls against one identity on a temporary
SQLite database. It proves that no update is lost. Add `pg` or `mysql2` when
you use PostgreSQL or MySQL.

Install the current release. `npm install solid-objects` selects it. Do not
pin a version that you remember from earlier work; the API changed between
releases. The current version is on <https://www.npmjs.com/package/solid-objects>.

Create the runtime and its tables at startup:

```typescript
import { configure } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

const runtime = configure({
  database: sqlite({ path: "app.sqlite3" }),
})

await runtime.install()
```

Every authorization callback denies by default. Do step 5 before you call an
actor. [Configuration](configuration.md) lists each option and database
adapter.

## 5. Authorize

All authorization callbacks deny by default. A new runtime answers no actor
call until you write a policy. Do not remove this behavior.

For a local demonstration only, grant messages and queries:

```typescript
const runtime = configure({
  database: sqlite({ path: "app.sqlite3" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
})
```

Keep `authorizeDestroy`, `authorizeSubscription`, and
`authorizeAdministration` denied in a demonstration.

A production policy must bind the actor type and ID to the authenticated user
or tenant. An actor ID is not a permission:

```typescript
const ownsCart = ({
  actorType,
  actorId,
  authorizationContext,
}: {
  actorType: string
  actorId: string
  authorizationContext: unknown
}) => {
  if (actorType !== "ShoppingCart") return false
  if (typeof authorizationContext !== "object" || authorizationContext === null) return false
  if (!("userId" in authorizationContext)) return false
  return typeof authorizationContext.userId === "string" && actorId === authorizationContext.userId
}

const runtime = configure({
  database: sqlite({ path: "app.sqlite3" }),
  authorizeMessage: ownsCart,
  authorizeQuery: ownsCart,
})
```

Pass the context on each call:

```typescript
await ShoppingCart.ref(subject.userId)
  .with({ authorizationContext: subject })
  .addItem({ productId: "shirt-123" })
```

[Authorization](authorization.md) covers each entry point.

## 6. Define an actor

This actor is the example from the [virtual actor guide](virtual-actors.md):

```typescript
import { Actor } from "solid-objects"

const HOLD_MILLISECONDS = 10 * 60 * 1000

export class TicketSale extends Actor {
  static override readonly actorType = "TicketSale"

  available = 1
  holds: Record<string, number> = {}

  hold({ buyer }: { buyer: string }): { held: boolean; available: number } {
    if (this.available === 0 || Object.hasOwn(this.holds, buyer)) {
      return { held: false, available: this.available }
    }

    this.available -= 1
    this.holds = { ...this.holds, [buyer]: Date.now() }
    this.schedule({ at: new Date(Date.now() + HOLD_MILLISECONDS), key: buyer }).expire({ buyer })
    return { held: true, available: this.available }
  }

  expire({ buyer }: { buyer: string }): number {
    if (!Object.hasOwn(this.holds, buyer)) return this.available

    const remainingHolds = { ...this.holds }
    delete remainingHolds[buyer]
    this.holds = remainingHolds
    this.available += 1
    return this.available
  }
}
```

Obey these rules in actor code:

- Give each actor class a stable `static actorType`. The database stores it.
- Enumerable public fields are the durable state. They must be
  JSON-compatible.
- Public methods are ordered operations. Each one takes no argument or one
  object argument.
- Use `this.schedule({ at, key })` for delayed work. A new `schedule` with the
  same key moves the alarm.
- Use `this.reject(code, { message })` for a business rule failure that must
  not retry. The second argument is an object, for example
  `this.reject("room_full", { message: "The room is full" })`.
- Do not write application tables directly from an operation. Use
  `this.commitAction()` for a short write in the same database.
- Do not call an external API in an operation. Use `this.emit()` and an effect
  handler.
- Write each operation so that it can run again. Delivery is at least once.

Avoid these mistakes:

| Mistake                                                    | Correct form                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `this.schedule({ at, key })` with no operation after it    | `this.schedule({ at, key }).expire({ buyer })`. `schedule()` stages a reminder only when you call an operation on its result |
| `this.reject("room full")` or `this.reject(code, message)` | `this.reject("room_full", { message: "The room is full" })`                                                                  |
| `registerEffect(name, (context, argumentsValue) => ...)`   | `registerEffect(name, (argumentsValue, context) => ...)`. The staged arguments come first                                    |
| A worker process that never names the actor class          | `runtime.register(TicketSale)` before `runtime.run(signal)`. See step 7                                                      |

[State and lifecycle](state-and-lifecycle.md) and the
[public API](api.md) give the full rules.

## 7. Run the background roles

A direct call, such as `TicketSale.ref("event-42").hold({ buyer: "ada" })`,
runs in the caller. These features need a process that calls
`runtime.run(signal)`:

- Reminders from `schedule()`.
- Effects from `emit()` and their callbacks.
- Messages to other actors.
- Realtime broadcasts.

The worker process runs only the actor classes that it knows. For a message
whose class is not registered, actor setup fails with `UnknownActorType`. The
worker reports `solid_objects.activation.failed` through instrumentation,
returns the message to the queue without counting an attempt, and tries again.
Nothing prints unless the application sets an `instrumentation` callback, so
the message seems to wait with no error. Register each class before `run()`:

```typescript
runtime.register(TicketSale)

const controller = new AbortController()
process.once("SIGTERM", () => controller.abort())
await runtime.run(controller.signal)
await runtime.close()
```

`TicketSale.ref(...)` also registers the class, so a script that calls `ref()`
before `run()`, like the direct call above, already works.

The packaged `solid-objects start` command does the same for a runtime that
`solid-objects.config.js` exports. When no process runs, committed work waits
in SQL and runs later. [Operations](operations.md) covers roles and shutdown.

## 8. Make external effects idempotent

Register an effect handler at startup. Use `context.id` as the provider
idempotency key:

```typescript
runtime.registerEffect("charge_payment", async (argumentsValue, context) => {
  return payments.charge({
    idempotencyKey: context.id,
    paymentId: argumentsValue.paymentId,
  })
})
```

Stage it from an operation:

```typescript
this.emit("charge_payment", {
  arguments: { paymentId: this.paymentId },
  onSuccess: "charged",
})
```

The effect can run more than once after a crash. The `context.id` value is the
same each time. [Effect recovery](effect-recovery.md) explains how to retire
abandoned work.

## 9. Verify the implementation

Do these checks before you report that the work is complete:

1. Call `await runtime.doctor.run()`. The report must contain no failed check.
2. Send concurrent calls to one identity with `Promise.all`, and from two
   processes if the application runs more than one. Assert the final state.
3. Test delayed work without sleeps. `runDueReminders({ now })` enqueues the
   reminders that are due at the `Date` you pass. `drain()` then runs the
   enqueued actor work:

   ```typescript
   await runtime.testing.runDueReminders({ now: new Date(Date.now() + HOLD_MILLISECONDS) })
   await runtime.testing.drain({ roles: ["actors"] })
   ```

4. Start a process that calls `runtime.run(signal)`, schedule a short
   reminder, and stop the process. Start it again after the deadline and
   confirm that the reminder ran.
5. Confirm that each effect handler deduplicates with `context.id`.
6. Confirm that production policies do not grant access to every caller.

The repository runs the same proofs. `pnpm run test:recovery` stops a worker
process and recovers its work. `pnpm run test:at-least-once` shows a repeated
effect and its deduplication.

## 10. Troubleshooting

| Symptom                                 | Cause and fix                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `Unauthorized`                          | A policy denied the call. Write the policy, and pass `authorizationContext`          |
| A reminder or effect does not run       | No process calls `runtime.run(signal)`. Start one                                    |
| `SyncInsideTransaction`                 | The call ran inside an open transaction. Call the actor outside the transaction      |
| `SyncTimeout`                           | The call did not finish in time. The message is still durable. Wait on its reference |
| `ApplicationWriteForbidden`             | An operation wrote an application table. Use `commitAction()` or `emit()`            |
| `Rejected`                              | The actor called `reject()`. This is a business result, not a retry                  |
| Wrong integer values or SQLite warnings | Node.js is older than 24.4, or older than 24.15 for the warning. Upgrade Node.js     |
| `ERR_REQUIRE_ESM` or import errors      | The package is ESM only. Use `import` and an ES module file                          |

## 11. Guarantees to state correctly

When you explain Solid Objects to a user, state these limits:

- Delivery is at least once, not exactly once.
- Calls for one identity are ordered. Different identities run concurrently.
- There are no transactions across actor identities.
- Fencing stops a stale activation from a commit, but its code can continue to
  run.
- The package is pre-1.0. It has no measured scale and no known third-party
  production use.
- The browser client is not the SQL runtime. The Cloudflare backend is
  experimental.

The [correctness contract](correctness.md) is the source for each guarantee.

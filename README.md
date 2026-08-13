# Solid Objects for JavaScript

Solid Objects is a durable virtual-actor runtime for Node.js. Each actor is
addressed by its class and ID, owns JSON state, and processes one durable
mailbox turn at a time.

This package ports the programming model of the Ruby
[`solid_objects`](https://github.com/cardmagic/solid_objects) gem to idiomatic
TypeScript. It does not share a database schema or wire protocol with the Ruby
runtime.

## Requirements

- Node.js 24.15 or newer
- TypeScript 5.9 or newer for TypeScript applications
- SQLite for the 0.1 release

The initial release focuses on the portable actor programming model and its
SQLite runtime. It does not include the Ruby gem's Rails engine, administration
UI, retention tooling, PostgreSQL/MySQL adapters, or Turbo rendering. Browser
delivery is transport-only: the host application owns its authenticated
WebSocket endpoint and rendering behavior.

## Installation

```bash
pnpm add solid-objects
```

## Define an actor

An actor is an ordinary class. Public fields are persisted state, public
methods are messages, and public getters are read-only queries.

```typescript
import { Actor } from "solid-objects"

export class Counter extends Actor {
  static override readonly actorType = "Counter"

  count = 0

  get doubled(): number {
    return this.count * 2
  }

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }

  override observables(): Record<string, unknown> {
    return { count: this.count }
  }
}
```

There is no actor-definition wrapper, state interface, decorator, or message
union to maintain. Native `#private` fields remain private and are not
persisted. Persisted fields, message arguments, results, and observable values
must be JSON-compatible.

`observables()` is deliberately explicit. State fields and getters do not
become realtime data automatically.

## Configure the runtime

```typescript
import { configureSolidObjects } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { Counter } from "./counter.js"

const runtime = configureSolidObjects({
  database: sqlite({ path: "storage/solid-objects.sqlite3" }),
  authorizeMessage: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeQuery: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeDestroy: ({ authorizationContext }) => authorizationContext !== undefined,
})

runtime.register(Counter)
await runtime.install()

const shutdown = new AbortController()
process.once("SIGTERM", () => shutdown.abort())
process.once("SIGINT", () => shutdown.abort())
await runtime.run(shutdown.signal)
```

Authorization for messages, queries, and destruction is deny-by-default. Actor
IDs identify actors; they are not capabilities.

## Invoke actors

`await` is the committed call boundary. JavaScript does not need separate
public synchronous and asynchronous invocation APIs.

```typescript
const counter = Counter.ref("primary")

const count = await counter.increment({ amount: 2 })
const doubled = await counter.doubled
```

The call is durably enqueued, waits its turn, and resolves with the committed,
deeply frozen result. A timeout never cancels the durable message.

Use `with()` when invocation behavior needs configuration:

```typescript
await counter
  .with({
    authorizationContext: currentUser,
    timeoutMilliseconds: 2_000,
    idempotencyKey: "increment-123",
  })
  .increment({ amount: 2 })
```

Invocation options stay separate from actor arguments, so an actor may safely
use argument names such as `timeoutMilliseconds` or `authorizationContext`.

## Enqueue without waiting

Use the typed `send` dispatcher for durable fire-and-forget work:

```typescript
const message = await counter.send.increment({ amount: 2 })

const delayed = await counter.send
  .with({
    availableAt: new Date(Date.now() + 60_000),
    idempotencyKey: "increment-later",
    authorizationContext: currentUser,
  })
  .increment({ amount: 2 })

await message.status()
await message.result()
await message.wait({ timeoutMilliseconds: 2_000 })
```

Actor code must not call another reference directly or through `send`. Use
`sendTo()` so outbound delivery commits atomically with the source actor turn:

```typescript
class Account extends Actor {
  static override readonly actorType = "Account"

  disable({ auditLogId }: { auditLogId: string }): void {
    this.sendTo(AuditLog.ref(auditLogId)).record({
      eventName: "account_disabled",
    })
  }
}
```

If `disable` fails or is rejected, the staged audit message is discarded.

## Reminders

Reminders are actor-owned durable alarms. The operation name is also the
reminder identity, so scheduling it again moves the existing reminder.

```typescript
class Trial extends Actor {
  static override readonly actorType = "Trial"

  expired = false

  armExpiration(): void {
    this.schedule({ at: new Date(Date.now() + 86_400_000) }).expire!()
  }

  expire(): void {
    this.expired = true
  }
}
```

The non-null assertion is only needed by projects using
`noUncheckedIndexedAccess`; runtime registration still rejects unknown reminder
messages before persistence. Recurring reminders accept `everyMilliseconds`
and a `missed` policy of `"latest"` or `"all"`.

## Effects

Effects run outside the actor turn through a transactional outbox. Handlers
must deduplicate external work using `context.id` because delivery is at least
once.

```typescript
class Checkout extends Actor {
  static override readonly actorType = "Checkout"

  status = "open"

  checkout({ paymentId }: { paymentId: string }): void {
    this.status = "pending"
    this.emit("chargePayment", {
      arguments: { paymentId },
      onSuccess: "paymentSucceeded",
      onFailure: "paymentFailed",
    })
  }

  paymentSucceeded(): void {
    this.status = "paid"
  }

  paymentFailed(): void {
    this.status = "failed"
  }
}

runtime.registerEffect("chargePayment", async ({ paymentId }, context) => {
  return payments.charge({ paymentId, idempotencyKey: context.id })
})
```

Success callbacks receive `{ effectId, result }`. Failure callbacks receive
`{ effectId, error }`.

## Commit actions

Commit actions make a short database-only write in the same fenced transaction
as actor state:

```typescript
runtime.registerCommitAction("completeAttempt", async ({ attemptId }, context) => {
  await context.connection.run("UPDATE attempts SET completed = 1 WHERE id = ?", [attemptId])
})
```

Do not perform network I/O in a commit action. Use an effect when work cannot
share the Solid Objects database transaction.

## Realtime observables and browsers

Configure `broadcast` to forward explicit observable changes to the transport
used by the application:

```typescript
const runtime = configureSolidObjects({
  database,
  broadcast: async (event) => websocketHub.publish(event),
  // authorization policies
})
```

The browser entry contains no Node imports. It validates versioned invalidation
envelopes, tracks actor incarnations and revisions, and ignores stale delivery:

```typescript
import { SolidObjectsBrowserClient } from "solid-objects/browser"

const client = new SolidObjectsBrowserClient({
  url: new URL("/solid-objects", window.location.href),
  onInvalidation: ({ observables }) => render(observables),
})

client.subscribe({ actorType: "Counter", actorId: "primary" })
client.connect()
```

The application owns WebSocket authentication and must authorize every
subscription server-side. Signed IDs and browser-visible values are not
authorization.

## Delivery contract

- Messages are ordered per actor identity and delivered at least once.
- Different actor identities may execute concurrently.
- State, completion, staged messages, effects, reminders, commit actions, and
  observable broadcasts share one fenced commit.
- A lost or expired activation lease cannot commit.
- Failed turns roll state and staged intents back and block later work until
  retry or dead-letter completion.
- Effects can execute more than once.
- Results and snapshots are deeply frozen copies.

## Current scope

Version 0.1 supports Node.js 24 and SQLite through the built-in `node:sqlite`
module. PostgreSQL and MySQL adapters, HTTP/WebSocket server adapters,
administrative tooling, and Ruby schema interoperability are not part of the
0.1 compatibility contract.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/correctness.md`](docs/correctness.md), and
[`docs/authorization.md`](docs/authorization.md) for the runtime contract.

## License

Solid Objects is released under the MIT License.

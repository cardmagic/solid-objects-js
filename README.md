# Solid Objects JS

**Stateful virtual actors for Node.js, powered entirely by your relational database.**

Get the programming model of Cloudflare Durable Objects without moving your
state into custom cloud isolates. Write ordinary TypeScript classes; Solid
Objects gives each instance a durable identity, persisted state, an ordered
mailbox, and safe one-at-a-time execution.

No Redis locks. No separate message broker for actor mailboxes. No proprietary
state service. The database you already understand provides the transaction,
lease, fencing, retry, timer, and outbox primitives.

> Version 0.1 supports SQLite through Node's built-in `node:sqlite` module.
> PostgreSQL and MySQL are not yet supported and are not implied by the current
> compatibility contract.

## The boring stack, with an actor model

Most stateful features eventually need the same machinery: load one entity,
serialize concurrent changes, persist the result, schedule follow-up work, and
recover after a process dies. Applications often assemble that machinery from
a database, Redis, a queue, distributed locks, and a pile of retry code.

Solid Objects keeps that coordination in one place: the relational database.

- An actor is addressed by its TypeScript class and ID.
- Public fields are JSON state.
- Public methods are durable operations.
- Public getters are ordered, read-only queries.
- Every actor has a durable, sequential mailbox.
- State, results, actor-to-actor delivery, effects, reminders, and observable
  invalidations commit together.
- Renewable leases and fencing prevent stale workers from committing.

## What you stop building

For workloads organized around durable identities—accounts, carts, game rooms,
workflows, devices, collaborative documents, or agent sessions—Solid Objects
replaces a recurring layer of infrastructure and application code:

- per-entity locking and race-condition handling;
- bespoke queue consumers that must preserve ordering;
- retry bookkeeping and poison-message handling;
- timer tables and scheduler claim logic;
- transactional outboxes for follow-up work; and
- durable invalidation bookkeeping.

This is not an in-memory actor library. A call is complete only after its state
and durable consequences commit to the database.

Solid Objects JS ports the programming model of the Ruby
[`solid_objects`](https://github.com/cardmagic/solid_objects) gem to idiomatic
TypeScript. The runtimes do not share a database schema or wire protocol.

## Requirements

- Node.js 24.15 or newer
- TypeScript 5.9 or newer for TypeScript applications
- SQLite for the 0.1 release

## Installation

```bash
pnpm add solid-objects
```

## Write an ordinary TypeScript class

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

No wrapper, state interface, decorator, or operation union is required. Native
`#private` fields remain private and are not persisted. Persisted fields,
operation arguments, results, and observable values must be JSON-compatible.

`observables()` is deliberately explicit. State fields and getters do not
become realtime data automatically.

## Point it at SQLite

```typescript
import { configureSolidObjects } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { Counter } from "./counter.js"

const runtime = configureSolidObjects({
  database: sqlite({ path: "storage/solid-objects.sqlite3" }),
  authorizeMessage: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeQuery: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeDestroy: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeAdministration: ({ authorizationContext }) => isOperator(authorizationContext),
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

## Call it like a local object

`await` is the committed call boundary.

```typescript
const counter = Counter.ref("primary")

const count = await counter.increment({ amount: 2 })
const doubled = await counter.doubled
```

The method call is still a durable database operation: it enters the actor's
mailbox, waits its turn, and resolves with the committed, deeply frozen result.
A timeout never cancels the durable message.

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

## Send background work without a queue service

Use the typed `send` dispatcher when the caller should not wait for execution:

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
`sendTo()` so outbound delivery commits atomically with the source actor turn—no
separate broker or hand-built transactional outbox required:

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

## Use database-backed timers

Reminders are actor-owned durable alarms. The operation name is also the
reminder identity, so scheduling it again moves the existing reminder.

```typescript
class Trial extends Actor {
  static override readonly actorType = "Trial"

  expired = false

  armExpiration(): void {
    this.schedule({ at: new Date(Date.now() + 86_400_000) }).expire!()
  }

  reconcile(): void {
    if (!this.expired) this.armExpiration()
  }

  expire(): void {
    this.expired = true
  }
}
```

The non-null assertion is only needed by projects using
`noUncheckedIndexedAccess`; runtime registration still rejects unknown reminder
operations before persistence. Recurring reminders accept `everyMilliseconds`
and a `missed` policy of `"latest"` or `"all"`.

## Keep external I/O outside the transaction

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

## Inspect and retry terminal failures

Messages that exhaust their attempts remain available as dead letters. Access
is deny-by-default and goes through the administration policy:

```typescript
const deadLetters = await runtime.deadLetters.all({
  authorizationContext: currentUser,
})

const deadLetter = deadLetters[0]
if (deadLetter) {
  await runtime.deadLetters.retry(deadLetter.id, {
    authorizationContext: currentUser,
  })
}
```

Retry creates one durable replacement message and records that link. Repeating
the retry returns the same `MessageReference` instead of enqueueing duplicate
work.

## Reconcile application-owned actors

Self-scheduling actors should have a low-frequency application reconciler for
lost alarms and lifecycle drift. The read side is bounded, immutable, and
administration-authorized:

```typescript
const page = await runtime.reconciliation.withoutPendingWork({
  actorType: Trial.actorType,
  quietForMilliseconds: 24 * 60 * 60 * 1_000,
  authorizationContext: currentUser,
})

for (const instance of page.items) {
  await Trial.ref(instance.actorId).send.reconcile()
}
```

`active()`, `statesFor()`, and `orphaned()` cover the other reconciliation
views. State batches are migrated to the registered actor's current version
before they are returned. Reconciliation never writes actor state directly;
repairs enter the ordinary durable mailbox.

## Retain history deliberately

Message history defaults to 30 days, stopped process history to 7 days, and
actor instances never expire unless their actor type opts in:

```typescript
const runtime = configureSolidObjects({
  database,
  messageRetentionMilliseconds: 30 * 24 * 60 * 60 * 1_000,
  messageRetentionByActorType: {
    [AuditEvent.actorType]: 365 * 24 * 60 * 60 * 1_000,
  },
  instanceRetentionByActorType: {
    [EphemeralSession.actorType]: 7 * 24 * 60 * 60 * 1_000,
  },
})
```

Preview each resource before pruning it:

```typescript
await runtime.retention.preview({
  target: "messages",
  authorizationContext: currentUser,
})

await runtime.retention.prune({
  target: "messages",
  authorizationContext: currentUser,
})
```

Pruning rechecks every candidate in bounded transactions. Live mailbox work,
unfinished outboxes, scheduled reminders, dead letters, retry links, active
leases, and running processes are retained.

## Verify an installation

The doctor returns a structured report for startup checks, deployment probes,
or an application-owned CLI:

```typescript
const report = await runtime.doctor.run()

for (const check of report.checks) {
  console.log(check.status, check.name, check.message)
}

if (!report.healthy) process.exitCode = 1
```

It checks configuration, schema migrations and required columns, SQLite's
server version, authorization-policy configuration, live runtime roles, and a
targeted durable actor round trip. The authorization check records which
policies were explicitly supplied; it never invokes application policies with
a fabricated subject. Pass `{ roundTrip: "skip" }` for a read-only report.

## Test durable workflows without sleeps

`runtime.testing.drain()` runs configured roles in deterministic passes until
they are idle. Select roles when a test needs a narrower boundary:

```typescript
const message = await Counter.ref("test").send.increment()

await runtime.testing.drain({ roles: ["actors"] })

expect(await message.status()).toBe("completed")
```

`runtime.testing.reset()` stops and discards the cached caller worker, then
deletes every actor-owned table and process row in dependency order. Use it in
test setup and teardown; it does not rely on transactional tests or foreign-key
cascades.

## Add realtime updates without exposing all state

Configure `broadcast` to forward explicit observable changes to the transport
used by the application:

```typescript
const runtime = configureSolidObjects({
  database,
  broadcast: async (event) => websocketHub.publish(event),
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
subscription server-side. Browser-visible actor IDs and observable values are
not authorization.

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
administrative command-line tooling, and Ruby schema interoperability are not
part of the 0.1 compatibility contract.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/correctness.md`](docs/correctness.md), and
[`docs/authorization.md`](docs/authorization.md) for the runtime contract. The
[`Ruby parity ledger`](docs/parity.md) tracks native equivalents and remaining
gaps against the current gem.

## License

Solid Objects is released under the MIT License.

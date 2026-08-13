# Solid Objects JS

**Stateful virtual actors for Node.js, powered entirely by your relational database.**

Get the programming model of Cloudflare Durable Objects without moving your
state into custom cloud isolates. Write ordinary TypeScript classes; Solid
Objects gives each instance a durable identity, persisted state, an ordered
mailbox, and safe one-at-a-time execution.

No Redis locks. No separate message broker for actor mailboxes. No proprietary
state service. The database you already understand provides the transaction,
lease, fencing, retry, timer, and outbox primitives.

> SQLite uses Node's built-in `node:sqlite` module. PostgreSQL 14 or newer and
> MySQL 8.0 or newer use optional driver peer dependencies.

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
- SQLite, PostgreSQL 14 or newer, or MySQL 8.0 or newer with InnoDB

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

## Point it at SQLite, PostgreSQL, or MySQL

SQLite needs no database driver package:

```typescript
import { configure } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { Counter } from "./counter.js"

const runtime = configure({
  database: sqlite({
    path: "storage/solid-objects.sqlite3",
    timeoutMilliseconds: 5_000,
    lockRetryAttempts: 10,
  }),
  authorizeMessage: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeQuery: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeDestroy: ({ authorizationContext }) => authorizationContext !== undefined,
  authorizeAdministration: ({ authorizationContext }) => isOperator(authorizationContext),
  authorizeSubscription: ({ actorId, authorizationContext }) =>
    authorizationContext?.canViewCounter(actorId) === true,
})

runtime.register(Counter)
await runtime.install()

const shutdown = new AbortController()
process.once("SIGTERM", () => shutdown.abort())
process.once("SIGINT", () => shutdown.abort())
await runtime.run(shutdown.signal)
```

SQLite serializes access inside one Node process. Across processes, it uses the
native busy timeout and retries transient `BEGIN IMMEDIATE` contention with
short capped backoff. `lockRetryAttempts` bounds those retries; synchronous
invocations remain bounded by their end-to-end `timeoutMilliseconds` deadline.

`configure()` installs this runtime as the default used by `Actor.ref()`. Use
`createRuntime()` when an application needs an isolated runtime and address its
actors through `runtime.ref(ActorClass, actorId)`. Actor code executing in that
runtime resolves its own actor references without changing the global default.

For PostgreSQL, install the optional driver and replace the database value:

```bash
pnpm add pg
```

```typescript
import { postgresql } from "solid-objects/database/postgresql"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is required")

const database = postgresql({
  connectionString,
  maximumConnections: 10,
})

const runtime = configure({
  database,
  wakeUp: database.wakeUp(),
})
```

PostgreSQL uses a bounded `pg` pool, 64-bit database timestamps and sequences,
row-locked sequence allocation, and the same durable polling contract as
SQLite. Keep `pg` at 8.23 or newer within the supported major. Portable
`DatabaseConnection` SQL uses `?` parameters; write `??` when a PostgreSQL query
needs the literal JSON existence operator.

`database.wakeUp()` is opt-in. It uses one event-driven PostgreSQL client per
runtime to listen on role-specific channels and wake every matching local
waiter. Create it in every process that should send or receive notifications.
Polling remains the fallback if a notification is missed or the listener
reconnects. Because `LISTEN` is session-scoped, use a direct connection or
session pooling rather than transaction pooling for this client.

For MySQL, install `mysql2` and configure its bounded promise pool:

```bash
pnpm add mysql2
```

```typescript
import { mysql } from "solid-objects/database/mysql"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is required")

const database = mysql({
  connectionString,
  maximumConnections: 10,
})
```

MySQL uses InnoDB tables, 64-bit database timestamps and sequences, row-locked
sequence allocation, and bounded retries around the side-effect-free enqueue
transaction when InnoDB selects it as a deadlock victim. Use the Redis wake-up
adapter when a MySQL deployment wants cross-process notification latency;
durable polling remains sufficient for correctness.

Authorization is deny-by-default. Actor IDs identify actors; they are not
capabilities.

`runtime.run()` supervises every built-in role and registered component. An
unexpected exit is cleaned up and rebuilt through its original factory with
capped exponential backoff. Shutdown stops replacement before asking the live
instances to finish, so no replacement can outlive the runtime. The shared
shutdown budget defaults to 15 seconds and can be changed with
`shutdownTimeoutMilliseconds`. Components and actor operations must cooperate
with cancellation where they receive an `AbortSignal`; actor operations and
other JavaScript code already running cannot be forcibly terminated.

The default in-process wake-up adapter interrupts role polling as soon as this
runtime commits new work. Polling remains the correctness fallback, so a missed
or failed signal costs latency rather than losing work. Multi-process hosts not
using PostgreSQL notifications can provide a `WakeUpAdapter` backed by their
existing notification system without adding a required broker to the default
SQLite stack.

Applications that already operate Redis can use its optional Pub/Sub adapter:

```bash
pnpm add redis
```

```typescript
import { redisWakeUp } from "solid-objects/wake-up/redis"

const runtime = configure({
  database,
  wakeUp: redisWakeUp({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" }),
})
```

The adapter lazily opens separate publisher and subscriber connections because
a subscribed Redis client cannot issue ordinary commands. Role-specific
channels wake every matching waiter in the process. Redis Pub/Sub is transient;
the relational database remains durable truth and bounded polling covers a
missed notification or unavailable Redis server.

## Call it like a local object

`await` is the committed call boundary.

```typescript
const counter = Counter.ref("primary")

const count = await counter.increment({ amount: 2 })
const doubled = await counter.doubled
```

The method call is still a durable database operation: it enters the actor's
mailbox, waits its turn, and resolves with the committed, deeply frozen result.
If the enqueue transaction commits, a later wait timeout does not cancel the
durable message. If enqueue itself cannot commit within the timeout,
`SyncEnqueueTimeout` is raised and no message exists to recover.

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
Every invocation receives a generated `requestId`; `idempotencyKey` remains the
caller's deduplication key and is never reused as request identity. During an
operation, `this.currentMessage` exposes both values along with `id`,
`enqueuedAt`, `actorType`, `actorId`, `sequence`, and `attempt`.

Do not make a committed actor call or wait on a message from inside
`database.transaction(...)` on the Solid Objects database. The runtime raises
`SyncInsideTransaction` before enqueue or waiting, avoiding a self-deadlock on
the transaction's checked-out connection. Send background work outside the
transaction, or let the actor coordinate same-database changes through a commit
action.

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

Authorized operators can inspect alarm metadata and resume a reminder that was
paused after a scheduler error:

```typescript
const paused = await runtime.reminders.all({
  status: "paused",
  authorizationContext: currentUser,
})

const reminder = paused.items[0]
if (reminder) {
  await runtime.reminders.resume(reminder.id, {
    runAt: new Date(Date.now() + 60_000),
    authorizationContext: currentUser,
  })
}
```

Inspection omits reminder arguments and error messages. Resume is idempotent;
completed reminders must be scheduled again by their owning actor.

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

Effect context also exposes `attempt`, `sourceMessageId`, `actorType`, and
`actorId`. The effect `id` is stable across retries and remains the external
idempotency key.

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

Commit-action context includes the source message and request IDs, actor
identity, mailbox sequence, activation generation, and the active transaction
connection.

Do not perform network I/O in a commit action. Use an effect when work cannot
share the Solid Objects database transaction.

When actors also read an application database, wrap that database with the
guarded facade and use the same facade everywhere:

```typescript
import { guardApplicationDatabase } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

const applicationDatabase = guardApplicationDatabase(sqlite({ path: "application.sqlite3" }))
```

During actor execution, observable and payload projection, and state migration,
the facade permits `SELECT` through `get()` and `all()` and rejects `run()` or
row-returning write statements. Registered commit actions run outside that
read-only context and may write through the same facade. This boundary is
opt-in: Solid Objects cannot intercept a separate ORM pool or an unwrapped
database client.

## Inspect and retry terminal failures

A committed invocation that exhausts its attempts raises `MessageFailed`.
The exception carries the durable `messageId` and the persisted error record in
`details`, so callers can correlate the failure without parsing its message.
If an already-authorized actor is destroyed while a caller is waiting,
`ActorDestroyed` is raised instead.

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
const runtime = configure({
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

It checks configuration, schema migrations and required columns, the database
server version and MySQL table engines, authorization-policy configuration,
live runtime roles, and a targeted durable actor round trip. The authorization
check records which policies were explicitly supplied; it never invokes
application policies with a fabricated subject. Pass `{ roundTrip: "skip" }`
for a read-only report.

Inspect role liveness with `runtime.processes.all()`. A process remains recorded
as `running` until graceful shutdown or cleanup, so each record also exposes a
current `stale` calculation based on the configured heartbeat threshold.
`runtime.processes.cleanup()` atomically marks stale owners stopped, releases
their actor activations, returns claimed messages to ready membership, and
releases their effect, reminder, and broadcast claims.

## Operate it from the command line

Export the configured runtime from an application module:

```javascript
import { configure } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { Counter } from "./dist/counter.js"

const runtime = configure({
  database: sqlite({ path: "storage/solid-objects.sqlite3" }),
  authorizeAdministration: ({ authorizationContext }) => authorizationContext?.source === "cli",
})

runtime.register(Counter)
export default runtime
```

The CLI loads `solid-objects.config.js` by default; use `--config` for another
compiled module:

```bash
pnpm exec solid-objects start
pnpm exec solid-objects doctor
pnpm exec solid-objects status
pnpm exec solid-objects cleanup
pnpm exec solid-objects dead-letters
pnpm exec solid-objects retry-dead-letter DEAD_LETTER_ID
pnpm exec solid-objects reminders --status paused
pnpm exec solid-objects resume-reminder REMINDER_ID
pnpm exec solid-objects prune messages
pnpm exec solid-objects prune messages --execute
```

Pruning is preview-only unless `--execute` is present. Administrative commands
use `{ source: "cli" }` as their authorization context and emit JSON for shell
automation.

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

## Connect observability without coupling the runtime

Provide a synchronous instrumentation sink and forward events to the
observability system already used by the application:

```typescript
const runtime = configure({
  database,
  instrumentation: (event) => diagnosticsChannel.publish(event),
})
```

Events use names such as `solid_objects.message.enqueued`,
`solid_objects.message.completed`, `solid_objects.effect.failed`,
`solid_objects.dead_letter.created`, and `solid_objects.actor.destroyed`.
Records are immutable and contain operational metadata only. Arguments, actor
state, results, rejection messages and details, error messages, and broadcast
payloads never enter the instrumentation API. A sink failure is logged and
cannot fail durable work.

Moving an existing alarm to another time emits
`solid_objects.reminder.replaced` only after the actor turn commits. The event
contains the actor identity, operation, reminder ID, and previous and next run
times without reminder arguments.

## Add realtime updates without exposing all state

Connect an authenticated socket to the transport-neutral subscription manager.
The application owns the WebSocket server and decides what object represents
the authenticated connection:

```typescript
server.on("connection", (socket, request) => {
  const session = runtime.realtime.connect({
    authorizationContext: request.user,
    send: (envelope) => socket.send(JSON.stringify(envelope)),
  })

  socket.on("message", (data) => {
    session.receive(data).catch(() => socket.close(1008, "subscription rejected"))
  })
  socket.on("close", () => session.close())
})
```

Every subscribe request calls `authorizeSubscription` before actor lookup. An
accepted subscription immediately receives the latest committed observable
projection with its actor incarnation and revision, without adding a mailbox
message. Later invalidations come from the durable outbox in actor revision
order. Duplicate and stale revisions are fenced, and one broken connection
cannot interrupt delivery to another.

Direct session delivery is process-local. When WebSocket connections and
workers run in several Node processes, configure `broadcast` to publish each
durable event through the application's shared transport, and have every
process feed received events to `runtime.realtime.publish(event)`. Polling and
the durable outbox remain the correctness fallback; the shared transport fans
a committed event out to the processes that own live connections.

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

For server-rendered or framework-owned UI fragments, register their observable
dependencies and let one invalidation refresh only the affected targets:

```typescript
import { SolidObjectsBrowserClient, SolidObjectsComponentRegistry } from "solid-objects/browser"

const componentRegistry = new SolidObjectsComponentRegistry<string>({
  refresh: async ({ actorType, actorId, instanceId, revision, batch, components, signal }) => {
    const response = await fetch("/components/refresh", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorType, actorId, instanceId, revision, batch, components }),
    })
    if (!response.ok) throw new Error(`component refresh failed with ${response.status}`)
    return response.json()
  },
  apply: ({ component, rendered }) => {
    updateComponent(component.target, rendered, { strategy: component.strategy })
  },
})

componentRegistry.register({
  actorType: "GameRoom",
  actorId: "table-1",
  target: "player-one",
  name: "player",
  key: 1,
  observes: ["playerOne"],
  batch: "playmat",
  strategy: "morph",
})

const client = new SolidObjectsBrowserClient({
  url: new URL("/solid-objects", window.location.href),
  onInvalidation: (envelope) => componentRegistry.invalidate(envelope),
})
```

Registrations sharing a batch are refreshed in one request. Same-revision
invalidations merge in a microtask, a strictly newer request aborts the older
one, and per-target incarnation/revision fences prevent a late response from
overwriting current UI. `replace` and `morph` are strategies passed to the
application's synchronous `apply` callback; the library does not assume a DOM
framework. The refresh endpoint must authenticate the request and reauthorize
every requested component and dependency.

Run `pnpm run test:browser` after installing Playwright's Chromium build to
exercise the browser entry through native WebSocket and browser APIs.

For subscriber-specific views, declare a static payload map with a TypeScript
`satisfies` check:

```typescript
import { Actor, type PayloadBroadcasts } from "solid-objects"

interface Viewer {
  accountId: string
}

class GameRoom extends Actor {
  static override readonly actorType = "GameRoom"
  static override readonly payloads = {
    playmat: (room, viewer) => ({
      turn: room.turn,
      hand: room.hands[viewer.accountId] ?? [],
    }),
  } satisfies PayloadBroadcasts<GameRoom, Viewer>

  turn = 1
  hands: Record<string, string[]> = {}
}
```

Request payloads by name and render them separately from observable
invalidations:

```typescript
const client = new SolidObjectsBrowserClient({
  url: new URL("/solid-objects", window.location.href),
  onInvalidation: ({ observables }) => renderScalars(observables),
  onPayload: ({ name, payload }) => renderPayload(name, payload),
})

client.subscribe({
  actorType: "GameRoom",
  actorId: "primary",
  payloads: ["playmat"],
})
```

Each payload runs against committed state and the subscribing session's fresh
authorization context. `authorizeQuery` is called with the payload name before
projection. A denied or failing payload is omitted without stopping sibling
payloads or observable invalidations.

`broadcast` remains available when an application also needs to forward the
same durable events through another transport or broker. Browser-visible actor
IDs and observable values are not authorization.

## Delivery contract

- Messages are ordered per actor identity and delivered at least once.
- Different actor identities may execute concurrently.
- A worker drains at most `maxMessagesPerActivationPass` turns from one actor,
  then yields its still-due work behind actors that were already waiting.
- A global claim scans at most `claimScanLimit` ordered candidates, continuing
  to another ready actor after a lost lease race.
- Long-running workers reuse hydrated actors for
  `idleDeactivationTimeoutMilliseconds` while renewing the same fenced lease.
- State, completion, staged messages, effects, reminders, commit actions, and
  observable broadcasts share one fenced commit.
- A lost or expired activation lease cannot commit.
- Failed turns roll state and staged intents back and block later work until
  retry or dead-letter completion.
- Effects can execute more than once.
- Results and snapshots are deeply frozen copies.

Override protected `onActivate()` and `onDeactivate()` methods when an actor
needs a process-local resource during that window. Hooks may be asynchronous,
cannot write through a guarded application database, and are nondurable;
`onDeactivate()` is best effort and must not carry correctness work.

## Current scope

The current runtime supports Node.js 24, SQLite through built-in `node:sqlite`,
PostgreSQL 14 or newer through `pg` 8.23, and MySQL 8.0 or newer through
`mysql2` 3.23 with InnoDB. HTTP/WebSocket server adapters and Ruby schema
interoperability are not part of the compatibility contract.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/correctness.md`](docs/correctness.md), and
[`docs/authorization.md`](docs/authorization.md) for the runtime contract. The
[`Ruby parity ledger`](docs/parity.md) tracks native equivalents and remaining
gaps against the current gem.

## License

Solid Objects is released under the MIT License.

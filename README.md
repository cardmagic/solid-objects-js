# Solid Objects JS

[![CI](https://github.com/cardmagic/solid-objects-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/cardmagic/solid-objects-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/solid-objects)](https://www.npmjs.com/package/solid-objects)

Open Source Durable Objects for JavaScript, in the SQL database you already run.
No daemon, no broker, and no new datastore.

Build addressable TypeScript objects with serialized calls and durable state on
SQLite, PostgreSQL, or MySQL. You don't need Cloudflare for this.

Concurrent calls for one identity cannot overwrite each other. Calls for
different identities can run at the same time.

Define ordinary TypeScript classes and run them in ordinary Node.js processes.
Solid Objects keeps the state, the queued operations, the retries, the
reminders, the effects, and the realtime invalidations in the database the
application already operates.

The same runtime also runs inside a browser worker on SQLite WASM, with
durable actor state in the origin's private file system, and its offline
writes can replay onto a Node **or Rails** backend over one shared wire
contract. See [Solid Objects in the browser](#solid-objects-in-the-browser).

> **Early release:** the correctness core has automated coverage. That coverage
> includes the supported databases, the Chromium browser client, the browser
> runtime, process recovery, and the packaged artifacts. The TypeScript
> implementation is still new. There is one deployed first-party reference
> application. There is no measured scale and no third-party production use
> yet. Read the
> [delivery boundaries](#delivery-boundaries) before you use it for important
> data.

> **Not a replacement for SQL transactions:** when one row update inside one
> transaction solves the problem, use that and install nothing. Solid Objects
> earns its cost when the critical section outlives the transaction: a hold that
> expires in ten minutes, work that must survive a restart, or a fan-in that
> spans many jobs. See
> [Why not just use a transaction and a row lock?](#why-not-just-use-a-transaction-and-a-row-lock).

## The programming model

A ticket sale for one event, with 100 seats and a hold that expires:

```typescript
import { Actor, broadcastValue, configure } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

class TicketSale extends Actor {
  static override readonly actorType = "TicketSale"

  remaining = 100
  holds: Record<string, number> = {}

  override observables(): Record<string, unknown> {
    return { remaining: broadcastValue(this.remaining) }
  }

  reserve({ buyer }: { buyer: string }): boolean {
    if (this.remaining === 0 || buyer in this.holds) return false
    this.remaining -= 1
    this.holds = { ...this.holds, [buyer]: Date.now() }
    this.schedule({ at: new Date(Date.now() + 600_000), key: buyer }).expire!({ buyer })
    return true
  }

  expire({ buyer }: { buyer: string }): void {
    if (!(buyer in this.holds)) return
    const rest = { ...this.holds }
    delete rest[buyer]
    this.holds = rest
    this.remaining += 1
  }
}

const runtime = configure({
  database: sqlite({ path: "tickets.sqlite3" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
})

await runtime.install()

try {
  const sale = TicketSale.ref("event-42")
  const buyers = ["ada", "grace", "alan"]
  await Promise.all(buyers.map((buyer) => sale.reserve({ buyer })))
} finally {
  await runtime.close()
}
```

Every reserve enters the durable mailbox for `event-42`. They execute in order
and commit one state transition at a time, even when different requests or
Node.js processes submit them concurrently, so the guard on `remaining` cannot
oversell.

That example wants three things from the same number. It must never go below
zero. It must give the seat back if the buyer does not pay within ten minutes.
It must show the current count to everyone watching the page.

The first is one UPDATE statement. The second is an `expiresAt` column plus a
sweeper. The third is a push on every code path that changes the number. The
combination is what costs, not any one of them. Here the guard, the ten-minute
alarm, and the published count are one class, and they commit together.

`install()` prepares the database and starts nothing. The example above finishes
because the caller's own path executes each call. A process serves background
work only after `runtime.run(signal)` starts its roles, so a process that
installs and then waits never claims a ready message. Nothing is lost while no
process runs. The message stays ready until one does.

```typescript
const controller = new AbortController()
process.on("SIGTERM", () => controller.abort())
await runtime.run(controller.signal)
```

## Why not just use a transaction and a row lock?

Often you should. If the whole job is read a row, decide, write it back, and
answer the request, then a transaction with `SELECT ... FOR UPDATE` does that
and you need nothing else installed. In the browser, `navigator.locks` is the
same answer. Reach for those first.

The argument for an actor is scope, not discipline. A lock is scoped to one
transaction, on one connection, in one process. The ticket sale above leaves
that scope on one line: the hold expires in ten minutes, and no transaction
stays open for ten minutes. A `setTimeout` does not cover it either, because it
dies with the process.

Any column named `expiresAt`, `scheduledAt`, or `nextRunAt` is evidence that
the critical section already outlived the lock that was supposed to cover it.
What follows such a column is a sweeper that looks for due rows, and then a
race between that sweeper and the next writer of the same row. The column, the
sweeper, and the race are what an actor replaces.

Three cases a lock cannot reach:

- work that fires at a future moment, when no transaction of yours is open;
- work that must survive a process restart, which rules out an in-process
  timer; and
- a fan-in whose critical section spans many jobs over minutes, such as an
  import that counts its own chunks as each one finishes.

If it all happens inside one request, use a lock. If something has to happen
later, or has to survive a restart, that is when this is worth installing.

## Is it worth installing here?

Worth it when several requests, jobs, or processes act on the same cart, room,
device, event, or session, and each next action needs the last committed state.
Worth it when that same thing also owns work that fires later, or a number a
live page must show.

Not worth it for a plain counter, a single-row update inside one transaction, a
stateless job, bulk ingestion or a data-parallel pipeline, CPU-heavy work, a
large JSON document that belongs in normalized rows, or a global rate-limit
counter that every request touches. One hot identity is serialized on purpose,
so making everything one identity makes a queue.

The longer version is in [What Solid Objects is for](#what-solid-objects-is-for),
[Good and poor fits](#good-and-poor-fits), and
[Choosing Solid Objects](docs/fit.md).

## Run it now with SQLite

Node.js 24.4.0 or newer is required. Node.js 24.15 or newer is preferred,
because `node:sqlite` prints an experimental warning before it. The published
package includes a quickstart:

```bash
npm exec --yes --package=solid-objects@latest -- solid-objects quickstart
```

The command needs no repository checkout, database server, Redis, container, or
application configuration. It uses Node's built-in SQLite module and removes
its scoped temporary database before exiting.

It states its plan first, prints the `Counter` class it runs, and asks for
permission. It executes the work only after you answer, and then it explains
what each result proves. It asks nothing when stdin is not a terminal, so CI
never waits. Add `--yes` to skip the question in a terminal, or `--json` for a
machine-readable summary.

The executable asserts rather than merely printing a plausible result. It exits
with a non-zero code when one of those checks fails.

## What Solid Objects is for

Use Solid Objects when more than one request, job, or process can act on the
same logical thing. The next action must then use the latest committed state of
that thing.
These are the stateful coordination patterns for which people often reach for
Durable Objects:

| Pattern                                 | One identity per              | What the object coordinates                                                                 |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Multiplayer, presence, or collaboration | Room, session, or document    | Joins, moves, and edits commit in order; subscribers refresh from committed state           |
| Reservations and expiring holds         | Show, resource, or stock item | Availability checks and holds cannot interleave; a durable reminder can release an old hold |
| Checkout and account workflows          | Cart, order, account, device  | The current step, retries, and effect results return to the same ordered mailbox            |
| Per-key rate limits                     | API key, account, or device   | Token checks and decrements are serialized; a reminder can refill the bucket                |
| Stateful agent sessions                 | Agent session                 | Messages and tool results apply in order and pending work survives a worker exit            |

The common shape is one durable coordination boundary with an application
defined identity. Work for that identity is serialized, while unrelated rooms,
carts, accounts, or sessions can progress concurrently. A single global rate
limiter or another very hot identity is a poor fit because it becomes an
intentional bottleneck. If one ordinary row transaction solves the problem,
prefer that. See [Choosing Solid Objects](docs/fit.md) for the longer guide.

## Measured behavior

One developer machine, not a capacity promise. Apple M5, Node.js 24.18.0, 250
measured operations at client concurrency 16, on August 22, 2026. PostgreSQL
17.11 and MySQL 9.7.1 run natively, not in a container.

| Measurement                                                   |           Result |
| ------------------------------------------------------------- | ---------------: |
| Committed operations per second, one hot identity, SQLite     | 286 to 323 ops/s |
| The same identity across four processes, SQLite               | 507 to 519 ops/s |
| The same identity across four processes, PostgreSQL           | 266 to 331 ops/s |
| The same identity across four processes, MySQL                | 214 to 228 ops/s |
| Idle wake-up to committed result, one process                 |      2.66 ms p50 |
| Idle wake-up to committed result, two processes, polling only |     1,006 ms p50 |
| Idle CPU per process, 100 ms fast interval                    |           0.121% |
| Idle database passes per second, after backoff                |              4.0 |

The four idle rows come from a separate harness on August 16, 2026.

Each range spans the synchronous and the asynchronous handler shape. Calls to
one identity are serialized on purpose, so the per-call latency in these runs
includes the wait behind the other fifteen concurrent callers. Throughput is
the honest number for that case.

The same PostgreSQL and MySQL versions in Docker Desktop reached 1.8x to 4.9x
less throughput on those rows. Measure your own deployment shape before you
plan capacity.

The polling-only row is the tradeoff to know before you deploy: use PostgreSQL
notifications or the optional Redis Pub/Sub when separate processes need
low-latency delivery.

Conditions, sources of bias, and the complete matrix for all three databases
are in [Benchmarks](docs/benchmarks.md).

## Running in a deployed application

[Shuffle Up and Play](https://shuffleupandplay.com/) is a deployed reference
application. Two players create a table, load decks, and move cards. Realtime
updates reach both browsers. Its
[source](https://github.com/cardmagic/shuffleupandplay) uses Node 24,
TypeScript, SQLite, `node:http`, and `ws`. Each table code addresses one
`GameRoom` actor that owns both seats, so mutations share one durable mailbox
while each player receives a separately authorized projection.

The application and its tests exercise more than a counter-shaped happy path:

| Production concern        | Verifiable application evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent mutations      | One [`GameRoom`](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/actors/game-room.ts#L45-L125) owns a table. [Mailbox tests](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/durability.test.ts#L39-L94) submit concurrent life, draw, and shuffle operations and assert the final committed state.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Controlled restarts       | [Restart tests](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/restart.test.ts#L38-L136) close and reopen the runtime against the same SQLite file, then assert recovery of committed state, an accepted asynchronous operation, an unfinished effect, and a scheduled reminder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Persistent deployment     | The [runtime uses SQLite](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/runtime.ts#L45-L63); the [container runs as an unprivileged user](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/Dockerfile#L20-L37), and [Kamal mounts a persistent volume](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/config/deploy.yml#L28-L43).                                                                                                                                                                                                                                                                                                                                                                  |
| Private realtime state    | [Subscription policy](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/runtime.ts#L65-L82) and [per-seat projection](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/game/room-snapshot.ts#L92-L130) run on the server. [HTTP](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/server.test.ts#L526-L567) and [WebSocket tests](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/realtime.test.ts#L184-L235) assert that opponent card identities are absent from player payloads and shared invalidation envelopes.                                                                                                                          |
| External work             | Deck imports run as [durable effects with success and failure callbacks](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/actors/game-room.ts#L192-L253). [Tests](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/game-room.test.ts#L209-L331) cover both outcomes and prevent a superseded callback from replacing a newer deck result.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Transactional staged work | A room operation stages an [actor-to-actor log message](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/actors/game-room.ts#L339-L349) and a [database commit action](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/runtime.ts#L96-L113). Tests cover [rollback of staged messages](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/durability.test.ts#L160-L192) and the [metrics write](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/server.test.ts#L467-L499).                                                                                                                                                                     |
| Time and schema changes   | The actor defines [versioned state migrations](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/actors/game-room.ts#L47-L91) and a [durable reminder](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/src/actors/game-room.ts#L276-L310). Tests load [stored version-one state](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/operations.test.ts#L135-L201) and [run the reminder scheduler](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/durability.test.ts#L236-L257).                                                                                                                                                                   |
| Operations and CI         | The [operations tests](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/operations.test.ts#L39-L202) exercise doctor, process, retention, and reconciliation APIs; server suites cover the [dashboard](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/server.test.ts#L297-L326), [rate limits](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/rate-limit.test.ts), and [shutdown](https://github.com/cardmagic/shuffleupandplay/blob/519a343e8db0bb6eed961a2ffd374dba80d67cd6/test/shutdown.test.ts). The [current main CI run](https://github.com/cardmagic/shuffleupandplay/actions/runs/31963000789) passed typechecking, 171 tests, the build, the doctor, and a Docker image build. |

**Scope:** the checked-in deployment configuration runs one Node process with
SQLite on one Docker host. It shows a real deployed workload. It does not show a
measured traffic level or every supported topology. Its deck-import effect reads
an external API. An effect that writes to an external system still needs a
stable idempotency key, because delivery is at least once. The restart tests
close the runtime cleanly. The library verifies abrupt termination, PostgreSQL,
MySQL, and multi-process lease fencing separately in its
[test matrix](docs/support.md),
[failure-recovery demonstration](examples/failure-recovery/demo.ts), and
[correctness contract](docs/correctness.md). Compare those guarantees and limits
with your own workload.

## How it works

Solid Objects addresses an object by its TypeScript class and its
application-defined ID. Public fields are JSON state, public methods are durable
operations, and public getters are ordered queries.

For each identity, Solid Objects:

1. commits calls to a durable per-ID mailbox;
2. claims one activation with a renewable lease;
3. executes one operation at a time outside the database transaction;
4. commits state, completion, and staged work in a short fenced transaction;
5. retries recoverable failures and exposes terminal failures as dead letters;
6. publishes committed realtime invalidations in revision order.

The fence includes the activation owner, token, generation, expiration, and
claimed message. A worker that finishes JavaScript after losing its lease
cannot commit. See the executable [failure-recovery demonstration](examples/failure-recovery/demo.ts)
and the full [architecture](docs/architecture.md).

Redis is optional wake-up infrastructure. It can reduce notification latency in
a multi-process MySQL deployment. The relational database stays the durable
source of truth, and polling stays the recovery path.

Idle roles back off from the configured 100 ms fast polling interval to one
second. Processed work and wake-up notifications reset that interval
immediately. The default wake-up reaches only the current Node process; use the
PostgreSQL or optional Redis adapter when separate processes need low-latency
delivery. The runtime warns once when it sees that topology without an adapter.

## Good and poor fits

| Good fit                                                  | Poor fit                                                  |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Multiplayer rooms and collaborative sessions              | A single-row update already solved by one SQL transaction |
| Shopping carts, accounts, devices, and per-user workflows | Bulk ingestion and data-parallel pipelines                |
| Stateful agent sessions with ordered tool results         | Very high-throughput global counters                      |
| Per-document or per-device reminders                      | Large JSON documents that should remain normalized rows   |
| Realtime projections of committed state                   | Globally placed edge state or managed elastic placement   |

One hot identity is intentionally serialized. Split an identity only when the
domain can tolerate independent ordering and transactions. Solid Objects does
not provide a transaction across object identities.

The longer decision guide is in [Choosing Solid Objects](docs/fit.md).

## Delivery boundaries

- Operations are ordered per identity and execute **at least once**.
- A crash after arbitrary external I/O but before the database commit can cause
  that I/O to repeat. Use the stable effect ID or another durable idempotency
  key at the external system.
- Fencing protects the Solid Objects database commit. It cannot undo an HTTP
  request, email, payment, file write, or other external side effect.
- Different identities can execute concurrently; one hot identity cannot.
- State, result, actor-to-actor delivery, reminders, effects, commit actions,
  and realtime invalidations commit together for one operation.
- Cross-object transactions are not provided.
- Application processes with incompatible `stateVersion` values must not run
  together. Older code rejects state written by a newer version.
- Direct application-database writes are guarded only when the application
  uses the supplied database facade. Unwrapped clients cannot be intercepted.
- Realtime sessions are process-local. A multi-process application must bridge
  committed broadcast events to the processes holding live connections.

See [Correctness and delivery semantics](docs/correctness.md) and
[Errors and recovery](docs/errors-and-recovery.md) for the complete contract.

## Realtime committed state

For a like count or a dashboard number, write the row and then send on your own
socket. That is less code than this library and it works.

It gets harder when several people write to the same record at once. Each
request builds its payload in its own process and sends it. The lock decided
who wrote first, but it has no say over which of the two sends arrives last, so
a viewer can be left looking at the older number. The second gap is that the
send is not part of the write: if the process dies after the database commits
and before the send goes out, the tab keeps a wrong number and nothing corrects
it.

An observable is the alternative. The change and its publication commit
together, so no crash can leave one without the other. A worker delivers the
publication afterwards, claiming rows in actor revision order, and subscribers
reject a duplicate or stale revision. Delivery is still at least once, so the
guarantee is that a subscriber cannot end up on an older value, not that a
value is sent exactly once.

Actors opt into browser-visible dependencies. In `0.13`, an unwrapped
observable triggers invalidation without storing or sending its value. Use
`broadcastValue()` only for a scalar that every authorized subscriber may see:

```typescript
import { Actor, broadcastValue } from "solid-objects"

class Room extends Actor {
  static override readonly actorType = "Room"

  version = 0
  privateHands: Record<string, string[]> = {}

  override observables(): Record<string, unknown> {
    return {
      version: broadcastValue(this.version),
      hands: this.privateHands,
    }
  }
}
```

`version` crosses the shared invalidation channel. `hands` contributes only its
name when its real value changes. A reauthorized component endpoint can then
render subscriber-specific state without a manual revision counter.

The browser package handles replay, reconnection, incarnation/revision fences,
personalized payloads, and framework-neutral component refresh. Applications
provide authentication, WebSocket transport, and rendering. See the
[browser protocol](docs/browser-protocol.md) and [authorization guide](docs/authorization.md).

## Solid Objects in the browser

The full runtime runs inside a browser module worker. Actors look exactly
like they do in Node; the database is SQLite WASM, and persistent storage
lives in the origin's private file system (OPFS), so actor state survives
page reloads.

```javascript
import { Actor, configure, sharedSqliteWasm } from "solid-objects/browser/host"

class Counter extends Actor {
  static actorType = "Counter"

  count = 0

  increment({ amount = 1 } = {}) {
    this.count += amount
    return this.count
  }
}

const runtime = configure({
  database: sharedSqliteWasm({ path: "app.db" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
})
await runtime.install()

await Counter.ref("page-hits").increment()
```

That code runs identically in every tab. `sharedSqliteWasm` elects one
database holder per origin through the Web Locks API, carries the other
tabs' SQL to it over a `BroadcastChannel`, and fails over onto the same
durable state when the holder's tab dies. Use `sqliteWasm` directly for a
single dedicated worker.

Two companions complete the local-first story:

- `solid-objects/browser/tab-host` runs one runtime for all tabs when the
  application prefers request-level routing: the leader's worker executes
  every operation, and other tabs invoke through a `BroadcastChannel` client
  by name.
- `solid-objects/transmit` drains the transactional effects outbox to a
  server with at-least-once delivery, per-actor order, and an idempotent
  server ingest, so offline writes reconcile when the network returns.

### The backend can be Rails, not only Node

The browser runtime does not require a Node server behind it. The transmit
wire contract is shared with the Ruby gem
([solid-objects-ruby](https://github.com/cardmagic/solid-objects-ruby)):
`SolidObjects::Transmission.receive` accepts the same envelopes as the Node
ingest `receiveTransmitEnvelope`, dedups on the same `transmit:<effectId>`
key, and both repositories pin the contract with one shared fixture file.
A browser front end on `solid-objects/browser/host` inside a Rails
application therefore replays its offline writes directly onto Ruby server
actors, with no Node service in between:

```ruby
class TransmitController < ApplicationController
  def create
    head :forbidden and return unless authenticated_device?

    SolidObjects::Transmission.receive(JSON.parse(request.body.read))
    head :ok
  end
end
```

The Ruby side of the family shipped in `solid_objects` 0.14.0, released the
same day as this package's 0.14.0
([solid-objects-ruby#49](https://github.com/cardmagic/solid-objects-ruby/pull/49)).

The wire shapes are documented in the
[browser protocol](docs/browser-protocol.md), the API in the
[public API reference](docs/api.md), and the platform boundaries in
[supported versions](docs/support.md).

## Comparison

These systems solve different coordination problems. The table describes their
default unit and deployment model, not a quality ranking.

| Approach                    | Serialization and state unit                          | Durable substrate                                | Additional runtime                                      | Recovery model                                           | Placement                                                 |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| SQL transaction or row lock | Selected rows in one transaction                      | Application database                             | None                                                    | Application retries the transaction                      | Application deployment                                    |
| Traditional job queue       | Job or queue; ordering depends on queue configuration | Broker or queue database                         | Queue workers and usually a broker                      | Retry the job                                            | Application deployment                                    |
| Solid Objects               | TypeScript class plus object ID                       | Existing SQLite, PostgreSQL, or MySQL            | Library in application processes                        | Retry the per-ID operation from durable state            | Application deployment                                    |
| Cloudflare Durable Objects  | Object class plus globally unique ID                  | Per-object managed storage                       | Cloudflare Workers platform                             | Managed object activation                                | Cloudflare-selected location                              |
| celld                       | Object class plus object name                         | Per-object SQLite replicated to a bucket you own | celld daemon that embeds V8 and runs Wrangler bundles   | A new owner restores the object database from the bucket | Any node in your fleet, chosen by bucket compare-and-swap |
| Rivet Actors                | Addressable actor                                     | Actor state, KV, or per-actor SQLite             | Rivet Engine or managed compute                         | Actor sleep, wake, and persistence                       | Configured Rivet deployment                               |
| DBOS                        | Workflow ID and checkpointed steps                    | PostgreSQL system database                       | Library; Conductor recommended for distributed recovery | Deterministic workflow replay from checkpoints           | Application deployment                                    |
| Restate                     | Service handler or keyed virtual object               | Restate log and state store                      | Restate server or cloud service                         | Durable handler execution and journal replay             | Restate deployment                                        |

celld and Solid Objects both self-host the Durable Objects model. The difference
is where the state lives and what you run. celld runs a daemon that embeds V8
and executes Wrangler bundles. It gives each object its own SQLite database,
and it replicates that database to an object-storage bucket you own. Object
ownership moves between nodes through compare-and-swap on that bucket. Solid
Objects runs plain TypeScript classes inside your Node processes, adds no
daemon, and keeps object state in the SQL database the application already
operates. Choose celld to run Workers-format code across a fleet with
bucket-based placement. Choose Solid Objects to keep one database, no extra
process, and an ordinary Node deployment.

[docs/comparisons.md](docs/comparisons.md) holds the sourced comparison for each
dimension: realtime projections, edge placement, cross-identity transactions,
and operational data access.

## Requirements and supported systems

- Node.js 24.4.0 or newer; 24.15 or newer to avoid the `node:sqlite`
  experimental warning
- TypeScript 5.9 or newer for TypeScript applications
- SQLite through `node:sqlite`, PostgreSQL 14 or newer, or MySQL 8.0 or newer
  with InnoDB
- optional `pg`, `mysql2`, `redis`, or `@sqlite.org/sqlite-wasm` peer
  dependency only for the selected adapter
- for the browser runtime: a browser with OPFS for persistent storage and the
  Web Locks API for the multi-tab host

[Supported versions](docs/support.md) records the exact CI matrix and the
boundaries.

## Operations

`runtime.run(signal)` supervises actor, effect, reminder, broadcast, retention,
and stale-process recovery roles. The database-backed operator dashboard is an
optional `solid-objects/web` export with deny-by-default administration policy,
session-backed CSRF protection, and Fetch or Node/Connect mounting.

The dashboard defaults to authorized read/write access. An authorized read-only
mode removes the mutations. Use the explicitly public read-only mode only for
synthetic demo data, because it exposes stored arguments, results, errors,
identifiers, and operational metadata.

Administration remains available through the JSON CLI and typed runtime
managers. See [Operations](docs/operations.md), the [dashboard guide](docs/dashboard.md),
and [Configuration](docs/configuration.md).

## Design provenance

Solid Objects JS is a Node.js and TypeScript implementation. The Ruby
[`solid_objects`](https://github.com/cardmagic/solid-objects-ruby) design informed
it. It began at the `0.12` capability generation, because the first
implementation targeted the Ruby `0.12` contract. That number does not represent
twelve earlier JavaScript release generations.

The TypeScript implementation is not a source translation. It redesigned the
API around inferred TypeScript references, Node runtime supervision,
`node:sqlite`/`pg`/`mysql2` adapters, transport-neutral realtime sessions,
Web Components, and browser-safe package exports. The
[parity ledger](docs/parity.md) records capability relationships and deliberate
runtime differences.

The Ruby project first appeared publicly on August 6, 2026, and this TypeScript
repository on August 13, 2026. Both remain early releases. The
[`mtg-playmat`](https://github.com/cardmagic/mtg-playmat) application uses the
Ruby actor and realtime design.
[Shuffle Up and Play](https://github.com/cardmagic/shuffleupandplay) uses the
TypeScript package in the deployed Node and SQLite topology above.

## Documentation

- [Getting the architecture right](docs/architecture.md)
- [Correctness and delivery semantics](docs/correctness.md)
- [Choosing Solid Objects](docs/fit.md)
- [Benchmarks and methodology](docs/benchmarks.md)
- [Supported versions and test matrix](docs/support.md)
- [Test suite](https://github.com/cardmagic/solid-objects-js/tree/main/test)
- [CI workflow](https://github.com/cardmagic/solid-objects-js/actions/workflows/ci.yml)
- [Public API](docs/api.md)
- [State and lifecycle](docs/state-and-lifecycle.md)
- [Operations, retention, and reconciliation](docs/operations.md)
- [Configuration](docs/configuration.md)
- [Authorization](docs/authorization.md)
- [Browser protocol](docs/browser-protocol.md)
- [Operator dashboard](docs/dashboard.md)
- [Errors and recovery](docs/errors-and-recovery.md)
- [Design parity](docs/parity.md)
- [Changelog](CHANGELOG.md)
- [Releases](https://github.com/cardmagic/solid-objects-js/releases)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Solid Objects is released under the [MIT License](MIT-LICENSE).

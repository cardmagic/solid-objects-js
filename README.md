# Durable Objects for Node, backed by your existing SQL database

[![CI](https://github.com/cardmagic/solid-objects-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/cardmagic/solid-objects-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/solid-objects)](https://www.npmjs.com/package/solid-objects)

Build addressable TypeScript objects with serialized calls and durable state
using SQLite, PostgreSQL, or MySQL, without deploying to Cloudflare.

Concurrent calls for one identity cannot overwrite each other. Calls for
different identities can run at the same time.

Define ordinary TypeScript classes and run them in ordinary Node.js processes.
State, queued operations, retries, reminders, effects, and realtime
invalidations are stored in the database the application already operates.

> **Early release:** the correctness core has automated coverage across the
> supported databases, the Chromium browser client, process recovery, and
> packaged artifacts, but the TypeScript implementation is new. Read the
> [delivery boundaries](#delivery-boundaries) before using it for important data.

## The programming model

```typescript
import { Actor } from "solid-objects"

class Cart extends Actor {
  static override readonly actorType = "Cart"

  items: string[] = []

  add({ sku }: { sku: string }): number {
    this.items.push(sku)
    return this.items.length
  }
}

const cart = Cart.ref("cart-123")
await Promise.all([cart.add({ sku: "blue-shirt" }), cart.add({ sku: "green-hat" })])
```

Both calls enter the durable mailbox for `cart-123`. They execute in order and
commit one state transition at a time, even when different requests or Node.js
processes submit them concurrently.

## Run it now with SQLite

Node.js 24.15 or newer is required. The `0.13.0` release includes a
packaged quickstart:

```bash
npm exec --yes --package=solid-objects@0.13.0 -- solid-objects quickstart
```

The command needs no repository checkout, database server, Redis, container, or
application configuration. It uses Node's built-in SQLite module and removes
its scoped temporary database before exiting.

The executable asserts rather than merely printing a plausible result. In one
local run, it verifies that:

- 25 concurrent calls to one identity produce the exact committed state `25`;
- their return values are the complete sequence from `1` through `25`;
- operations for two different identities overlap in time; and
- the runtime closes and temporary state is removed.

## Running in a deployed application

[Shuffle Up and Play](https://shuffleupandplay.com/) is a deployed reference
application where two players create a table, load decks, and move cards while
realtime updates reach both browsers. Its
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

**Scope:** the checked-in deployment configuration runs one Node process using
SQLite on one Docker host. It demonstrates a real deployed workload, not a
measured traffic level or every supported topology. Its deck-import effect
reads an external API; effects that write to an external system still need a
stable idempotency key because delivery is at least once. The application
restart tests close the runtime cleanly; abrupt termination, PostgreSQL, MySQL,
and multi-process lease fencing are verified separately by the library's
[test matrix](docs/support.md),
[failure-recovery demonstration](examples/failure-recovery/demo.ts), and
[correctness contract](docs/correctness.md). Evaluate those guarantees and
limits against your own workload.

## What Solid Objects is for

Use Solid Objects when more than one request, job, or process can act on the
same logical thing and the next action must use its latest committed state.
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

## How it works

An object is addressed by its TypeScript class and application-defined ID.
Public fields are JSON state, public methods are durable operations, and public
getters are ordered queries.

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

Redis is optional wake-up infrastructure. It can reduce notification latency
for a multi-process MySQL deployment, but the relational database remains the
durable source of truth and polling remains the recovery path.

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
name when its real value changes, allowing a reauthorized component endpoint to
render subscriber-specific state without a manual revision counter.

The browser package handles replay, reconnection, incarnation/revision fences,
personalized payloads, and framework-neutral component refresh. Applications
provide authentication, WebSocket transport, and rendering. See the
[browser protocol](docs/browser-protocol.md) and [authorization guide](docs/authorization.md).

## Comparison

These systems solve different coordination problems. The table describes their
default unit and deployment model, not a quality ranking.

| Approach                    | Serialization and state unit                          | Durable substrate                     | Additional runtime                                      | Recovery model                                 | Placement                    |
| --------------------------- | ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| SQL transaction or row lock | Selected rows in one transaction                      | Application database                  | None                                                    | Application retries the transaction            | Application deployment       |
| Traditional job queue       | Job or queue; ordering depends on queue configuration | Broker or queue database              | Queue workers and usually a broker                      | Retry the job                                  | Application deployment       |
| Solid Objects               | TypeScript class plus object ID                       | Existing SQLite, PostgreSQL, or MySQL | Library in application processes                        | Retry the per-ID operation from durable state  | Application deployment       |
| Cloudflare Durable Objects  | Object class plus globally unique ID                  | Per-object managed storage            | Cloudflare Workers platform                             | Managed object activation                      | Cloudflare-selected location |
| Rivet Actors                | Addressable actor                                     | Actor state, KV, or per-actor SQLite  | Rivet Engine or managed compute                         | Actor sleep, wake, and persistence             | Configured Rivet deployment  |
| DBOS                        | Workflow ID and checkpointed steps                    | PostgreSQL system database            | Library; Conductor recommended for distributed recovery | Deterministic workflow replay from checkpoints | Application deployment       |
| Restate                     | Service handler or keyed virtual object               | Restate log and state store           | Restate server or cloud service                         | Durable handler execution and journal replay   | Restate deployment           |

The sourced, dimension-by-dimension comparison—including realtime projections,
edge placement, cross-identity transactions, and operational data access—is in
[docs/comparisons.md](docs/comparisons.md).

## Requirements and supported systems

- Node.js 24.15 or newer
- TypeScript 5.9 or newer for TypeScript applications
- SQLite through `node:sqlite`, PostgreSQL 14 or newer, or MySQL 8.0 or newer
  with InnoDB
- optional `pg`, `mysql2`, or `redis` peer dependency only for the selected
  adapter

The exact CI matrix and boundaries are documented in
[Supported versions](docs/support.md).

## Operations

`runtime.run(signal)` supervises actor, effect, reminder, broadcast, retention,
and stale-process recovery roles. The database-backed operator dashboard is an
optional `solid-objects/web` export with deny-by-default administration policy,
session-backed CSRF protection, and Fetch or Node/Connect mounting.

The dashboard defaults to authorized read/write access. An authorized
read-only mode removes mutations, while an explicitly public read-only mode is
appropriate only for synthetic demo data because it exposes stored arguments,
results, errors, identifiers, and operational metadata.

Administration remains available through the JSON CLI and typed runtime
managers. See [Operations](docs/operations.md), the [dashboard guide](docs/dashboard.md),
and [Configuration](docs/configuration.md).

## Design provenance

Solid Objects JS is a Node.js and TypeScript implementation informed by the
Ruby [`solid_objects`](https://github.com/cardmagic/solid_objects) design. It
began at the `0.12` capability generation because the initial implementation
targeted the Ruby `0.12` contract; the number does not represent twelve earlier
JavaScript release generations.

The TypeScript implementation is not a source translation. It redesigned the
API around inferred TypeScript references, Node runtime supervision,
`node:sqlite`/`pg`/`mysql2` adapters, transport-neutral realtime sessions,
Web Components, and browser-safe package exports. The
[parity ledger](docs/parity.md) records capability relationships and deliberate
runtime differences.

The Ruby project first appeared publicly on August 6, 2026, and this TypeScript
repository on August 13, 2026. Both remain early releases. The
[`mtg-playmat`](https://github.com/cardmagic/mtg-playmat) application uses the
Ruby actor and realtime design, while
[Shuffle Up and Play](https://github.com/cardmagic/shuffleupandplay) uses the
TypeScript package in the deployed Node and SQLite topology documented above.

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

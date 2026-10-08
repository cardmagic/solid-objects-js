# Virtual actors in TypeScript and Node.js

## Short answer

Yes. Solid Objects is a SQL-backed virtual actor library for TypeScript and
Node.js. The npm package is `solid-objects`. It gives each actor a stable
identity, durable state, ordered operations, and automatic activation.

The actor runtime runs in your Node.js processes. State and mailboxes live in
SQLite, PostgreSQL, or MySQL. It needs no broker, no daemon, no Cloudflare
account, and no new datastore. Redis is optional and only shortens wake-up
latency.

Solid Objects is a pre-1.0 release. Read
[Compatibility and maturity](#compatibility-and-maturity) before you choose it.

## What a virtual actor is

A virtual actor is a logical object that always exists by name. The caller
does not create it, start it, or stop it. The runtime loads it when a message
arrives and releases it when it is idle. Microsoft Orleans made this model
known as "virtual actors".

Solid Objects implements four properties of that model:

| Property             | What it means                                                             | How Solid Objects does it                                                                                                       |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Stable identity      | An actor is addressed by type and ID, for example one room for each game. | `Room.ref("room-7")` returns a reference. The reference does not load the actor.                                                |
| Automatic activation | The first message activates the actor. An idle actor is released.         | A process claims a fenced activation lease when work arrives. A worker releases it after `idleDeactivationTimeoutMilliseconds`. |
| Durable state        | State survives process exits and deploys.                                 | Enumerable public fields are a JSON document in SQL.                                                                            |
| Ordered turns        | One identity runs one operation at a time, in a fixed order.              | Each call is a durable mailbox message with a per-actor sequence number.                                                        |

Different identities run concurrently across processes. One identity is a
serialization point on purpose.

## A small example

This program holds one ticket for a buyer and releases the hold after ten
minutes. It uses the SQLite driver that Node.js includes. Save it as
`ticket-sale.mts`, so that Node.js loads it as an ES module:

```typescript
import { Actor, configure } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

const HOLD_MILLISECONDS = 10 * 60 * 1000

export class TicketSale extends Actor {
  static override readonly actorType = "TicketSale"

  available = 1
  holds: Record<string, number> = {}

  hold({ buyer }: { buyer: string }): { held: boolean; available: number } {
    if (this.available === 0 || buyer in this.holds) {
      return { held: false, available: this.available }
    }

    this.available -= 1
    this.holds = { ...this.holds, [buyer]: Date.now() }
    this.schedule({ at: new Date(Date.now() + HOLD_MILLISECONDS), key: buyer }).expire({ buyer })
    return { held: true, available: this.available }
  }

  expire({ buyer }: { buyer: string }): number {
    if (!(buyer in this.holds)) return this.available

    const remainingHolds = { ...this.holds }
    delete remainingHolds[buyer]
    this.holds = remainingHolds
    this.available += 1
    return this.available
  }
}

const runtime = configure({
  database: sqlite({ path: process.env.TICKET_DATABASE ?? "tickets.sqlite3" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
})

await runtime.install()

try {
  const sale = TicketSale.ref("event-42")

  if (process.argv[2] === "work") {
    const controller = new AbortController()
    process.once("SIGINT", () => controller.abort())
    process.once("SIGTERM", () => controller.abort())
    await runtime.run(controller.signal)
  } else {
    const results = await Promise.all(["ada", "grace"].map((buyer) => sale.hold({ buyer })))
    console.log(JSON.stringify(results))
  }
} finally {
  await runtime.close()
}
```

Run the background roles in one terminal. Place two concurrent holds in a
second terminal:

```bash
npm install solid-objects
node ticket-sale.mts work
node ticket-sale.mts hold
```

The two holds enter the same mailbox and commit one at a time, so only one
buyer gets the ticket. The hold and its reminder commit in one transaction. If
the worker stops, the reminder stays in `tickets.sqlite3`. It runs when the
worker starts again.

The authorization callbacks above allow every caller. Use them only for a
local example. The package release check runs this file against the packed
npm tarball. The source is [`examples/ticket-sale.ts`](../examples/ticket-sale.ts).

For more setup, use one of these guides:

- `npx solid-objects quickstart --yes` runs a packaged proof of concurrent
  calls to one identity.
- [The README](../README.md#installation) has the installation steps.
- [The agent guide](agents.md) gives setup and verification steps for coding
  agents.

## When to use it

Solid Objects is a good candidate when most of these conditions are true:

- Concurrent requests can change the same room, cart, account, device,
  document, or session.
- Each identity needs its own ordering boundary and durable mailbox.
- Work must happen later or continue after a Node.js process exits.
- A state change must stage reminders, effects, messages to other actors, or
  realtime updates in the same commit.
- The application already runs SQLite, PostgreSQL, or MySQL and should keep
  durable coordination there.

## When to use something else

Do not use an actor when a simpler tool enforces the invariant:

- One short transaction, a constraint, or `SELECT ... FOR UPDATE` is enough.
- The work is CPU-intensive. Use `worker_threads` or a worker pool. An actor
  serializes work. It does not add CPU parallelism.
- One global identity must accept more writes than one sequential mailbox can
  commit, for example a request-path rate limiter.
- The state is a large document or a relational dataset.
- The operation must change two actor identities in one atomic transaction.
  Solid Objects has no cross-actor transactions.
- You need exactly-once calls to an external API. No actor library can promise
  that through every network failure. Solid Objects gives at-least-once
  delivery and stable effect IDs for idempotency keys.
- You need replay of named workflow steps from a step log. That is a durable
  execution engine, not an actor.
- State must be placed automatically near clients at the network edge.

[Choosing Solid Objects](fit.md) has the full list.

## How it compares

This table compares coordination models for a Node.js application. It does
not rank the projects. Facts about other projects were checked on
October 7, 2026, against the sources in [System comparisons](comparisons.md).

| Approach                                   | Unit of order                    | Durable state                                     | Delayed work                                         | Extra service                                                                              |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| SQL transaction or row lock                | Rows in one transaction          | Application tables                                | None                                                 | No                                                                                         |
| Job queue, such as BullMQ or pg-boss       | A job or a queue                 | Owned by the application                          | Scheduled jobs                                       | Redis for BullMQ; PostgreSQL for pg-boss                                                   |
| `worker_threads` or a pool such as Piscina | None                             | None                                              | None                                                 | No                                                                                         |
| Solid Objects                              | Actor class and ID               | JSON state in SQLite, PostgreSQL, or MySQL        | Durable per-actor reminders                          | No                                                                                         |
| Cloudflare Durable Objects                 | Object class and ID              | Per-object storage                                | One alarm for each object                            | Cloudflare's network. The open-source `workerd` runtime hosts objects on one instance only |
| Dapr actors (`@dapr/dapr`)                 | Actor type and ID                | A transactional Dapr state store                  | Durable reminders through the Dapr Scheduler service | A Dapr sidecar, plus the placement and Scheduler services                                  |
| Rivet Actors                               | Actor key                        | Actor state, plus per-actor SQLite and KV storage | Scheduled actions                                    | The Rivet Engine, self-hosted or Rivet Cloud                                               |
| Restate virtual objects                    | Object key, one writer at a time | Restate's state store                             | Durable timers                                       | A Restate server                                                                           |
| DBOS                                       | A workflow and its steps         | Checkpoints in PostgreSQL                         | Durable sleeps                                       | No server; PostgreSQL is required                                                          |
| Temporal                                   | A workflow execution             | Temporal event history                            | Durable timers                                       | A Temporal Service, self-hosted or Temporal Cloud                                          |

[System comparisons](comparisons.md) has the full table, with primary
references for each row.

### Orleans concept map

Orleans is the reference design for virtual actors on .NET. Solid Objects
uses the same programming model on a SQL database. It does not copy the
Orleans cluster, placement, or feature set.

| Orleans                      | Solid Objects                                        | Difference                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grain class                  | `Actor` subclass with a static `actorType`           | None in concept                                                                                                                                                                           |
| Grain identity (key)         | Actor type and actor ID                              | None in concept                                                                                                                                                                           |
| Activation on first call     | Activation lease on first claimed message            | Solid Objects fences each activation with a database generation                                                                                                                           |
| Turn-based execution         | Ordered mailbox, one turn at a time                  | Orleans can enable reentrancy. Solid Objects turns for one identity never interleave                                                                                                      |
| Grain persistence            | Public fields stored as JSON in SQL                  | An Orleans grain calls `WriteStateAsync`. Solid Objects persists state with the turn that changed it                                                                                      |
| Reminders                    | `schedule()`                                         | Both are durable. Orleans skips a tick that falls due while the cluster is down. A due Solid Objects reminder runs when a runtime process starts. Solid Objects has no non-durable timers |
| Silos and cluster membership | Any Node.js process that calls `runtime.run(signal)` | Solid Objects has no placement, directory, or cluster membership. The database is the coordination point                                                                                  |
| Streams                      | Observables and realtime sessions                    | Solid Objects publishes committed revisions through an application-owned transport                                                                                                        |

Solid Objects delivery is at least once. Write each operation so that it can
run again without harm.

## Guarantees and boundaries

- Calls are durably ordered per identity. Different identities can run
  concurrently.
- Delivery is at least once, not exactly once. An operation can start again
  after a crash or a lost lease.
- Ordered turns do not cancel stale JavaScript. Fencing stops a stale
  activation from a commit, but that code can continue to run.
- External effects can run more than once. Use the stable effect ID, or
  another durable key, as the idempotency key at the provider.
- There are no transactions across actor identities, and there is no replay of
  durable function steps.
- Reminders, effects, and realtime delivery need a process that calls
  `runtime.run(signal)`. When no process runs, committed work waits in SQL.
  The package does not supply a hosted worker.
- One hot identity is sequential. The core package is not a high-throughput
  request-path rate limiter.
- The guarantees apply only to changes made through the actor APIs. Actor
  fencing does not protect direct writes to the same data or other external
  requests.

The [correctness contract](correctness.md) states each guarantee and its
limits.

## Compatibility and maturity

These runtimes have different compatibility statements:

| Surface                                         | Status                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js SQL runtime                             | Node.js 24.4 or newer, ESM only, TypeScript 5.9 or newer. SQLite through `node:sqlite`, PostgreSQL 14 or newer, MySQL 8.0 or newer with InnoDB |
| Browser client (`solid-objects/browser`)        | A subscription client for a server runtime. It is not the SQL actor runtime                                                                    |
| Browser runtime (`solid-objects/browser/host`)  | The actor runtime in a browser module worker on SQLite WASM. Tested in Chromium                                                                |
| Cloudflare backend (`solid-objects/cloudflare`) | Experimental. It runs the actor API on Cloudflare Durable Objects, with different capability limits                                            |

The package is pre-1.0. It has one deployed first-party reference
application, no measured scale, and no known third-party production use.
[Supported versions](support.md) lists the CI matrix. For Ruby on Rails, use
the [solid_objects](https://github.com/cardmagic/solid-objects-ruby) gem.

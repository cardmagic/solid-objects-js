# Solid Objects for Node and Your Browser

[![CI](https://github.com/cardmagic/solid-objects-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/cardmagic/solid-objects-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/solid-objects)](https://www.npmjs.com/package/solid-objects)

**Open Source Durable Objects in your Node app.**

In a shopping cart, paying twice at the same time is a big problem. The payment provider might time out, and your Node site could be restarting before recovery finishes.

To deal with this safely, you often need logic scattered between 7-10 files like database row locks, Redis locks, delayed jobs, retries, and cleanup code to keep that process straight. They are not all large, but they must agree about the same payment state and failure rules. That coordination is the difficult part.

With Solid Objects, one actor in one file owns each shopping cart's full state and recovery work. Method calls on that object run one at a time, state lives in your existing SQL database, and scheduled recovery resume after restarts.

Solid Object JavaScript Actors elegantly fit anything where one identifiable thing must remember state, handle competing requests in order, or wake up later:

- Ticket holds and reservations
- Multiplayer games and shared rooms
- Shopping carts and checkout recovery
- Rate limits and account quotas
- Session expiration
- Job leases and workflows
- Connected devices
- Collaborative documents

And so much more.

## Contents

- [Installation](#installation)
- [An expiring ticket hold](#an-expiring-ticket-hold)
- [Why this exists](#why-this-exists)
- [Good uses](#good-uses)
- [When a transaction is better](#when-a-transaction-is-better)
- [Guarantees and boundaries](#guarantees-and-boundaries)
- [Read more](#read-more)
- [Status and license](#status-and-license)

## Installation

Solid Objects is ESM-only and requires Node.js 24.4 or newer. TypeScript users
need TypeScript 5.9 or newer.

```bash
npm install solid-objects
npx solid-objects quickstart --yes
```

The quickstart uses Node's built-in SQLite driver and proves that concurrent
calls to one identity do not overwrite each other. It is an unusually formal
introduction to addition.

## An expiring ticket hold

Save this as `ticket-sale.mjs`:

```javascript
import { Actor, configure } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

const HOLD_MILLISECONDS = 10 * 60 * 1000

class TicketSale extends Actor {
  static actorType = "TicketSale"
  available = 1
  holds = {}

  hold({ buyer }) {
    if (this.available === 0 || buyer in this.holds) {
      return { held: false, available: this.available }
    }

    this.available -= 1
    this.holds = { ...this.holds, [buyer]: Date.now() }
    this.schedule({
      at: new Date(Date.now() + HOLD_MILLISECONDS),
      key: buyer,
    }).expire({ buyer })
    return { held: true, available: this.available }
  }

  expire({ buyer }) {
    if (!(buyer in this.holds)) return this.available

    const remainingHolds = { ...this.holds }
    delete remainingHolds[buyer]
    this.holds = remainingHolds
    this.available += 1
    return this.available
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

  if ((process.argv[2] ?? "hold") === "work") {
    const controller = new AbortController()
    process.once("SIGINT", () => controller.abort())
    process.once("SIGTERM", () => controller.abort())
    await runtime.run(controller.signal)
  } else {
    console.log(await Promise.all(["ada", "grace"].map((buyer) => sale.hold({ buyer }))))
  }
} finally {
  await runtime.close()
}
```

Run the background roles in one terminal and place two concurrent holds in
another:

```bash
node ticket-sale.mjs work
node ticket-sale.mjs hold
```

Only one buyer gets the ticket. The successful call stores the hold and its
ten-minute expiry together. Stop the worker process before the deadline and
restart it afterwards; the reminder is still in `tickets.sqlite3` and runs when
the process returns. We have now given `available += 1` a recovery plan.

The authorization callbacks above are for this local example only. Production
policies must bind actor IDs and operations to the authenticated user or tenant.

## Why this exists

The handwritten version usually starts with a row lock. Then it gains an
`expiresAt` column, a sweeper, retries, per-room ordering, and a broadcast path
that must agree with the write. The original transaction has developed a robust
interplay with four other subsystems.

Solid Objects makes the application-defined identity the coordination boundary.
Its state, mailbox, retries, reminders, and staged consequences live in SQLite,
PostgreSQL, or MySQL. No daemon, broker, Cloudflare account, or new datastore is
required. Redis is optional wake-up plumbing, not durable state.

## Good uses

- Multiplayer rooms, collaborative sessions, and documents with ordered edits.
- Carts, reservations, and inventory holds with durable expiry.
- Accounts, devices, and long-lived jobs whose next action depends on committed state.
- Realtime multi-user state where publications must follow committed revisions.

Different identities can run concurrently. One global identity is merely a
queue wearing an ambitious name.

Browser support is available without making this README about browser setup:
the client subscribes to server actors, and the full runtime can run in a browser
worker on SQLite WASM and OPFS. See the [browser protocol](docs/browser-protocol.md).

## When a transaction is better

Often. If all the work happens in one request, use a transaction, constraint, or
`SELECT ... FOR UPDATE`. It is smaller, faster, and does not need a manifesto.

Use Solid Objects when the critical section outlives that transaction: work
must happen later, survive a restart, or remain ordered across several requests
or jobs. A plain counter is not a reason to install this package.

## Guarantees and boundaries

- Calls are durably ordered per identity. Different identities may run concurrently.
- Delivery is **at least once**, not exactly once. A handler can begin again after a crash.
- One successful turn commits state and staged reminders, messages, effects, and realtime publications together.
- Fencing prevents a stale worker from committing, though its JavaScript may keep running. It cannot undo an HTTP request, email, payment, or file write.
- External effects can repeat and must use the stable effect ID or another durable idempotency key.
- One hot identity is intentionally sequential. There are no transactions across identities.
- Background work needs `runtime.run(signal)`. If no process is running, committed work waits in SQL rather than disappearing.
- Your application still owns authorization, database backups, failover, WebSocket transport, and capacity planning.

Exactly once remains absent, despite its excellent branding. Read the
[correctness contract](docs/correctness.md) before using important data.

## Read more

- [Five-minute Node guide](https://solidobjects.dev/5min/node)
- [Choosing Solid Objects](docs/fit.md)
- [Public API](docs/api.md)
- [Operations and recovery](docs/operations.md)
- [Detailed architecture](docs/architecture.md)
- [Detailed documentation](docs/)

The benchmarks, parity ledger, dashboard, browser setup, and exhaustive API
notes remain in `docs/`, where long documentation can be long on purpose.

## Status and license

Solid Objects JS 0.14.3 is a pre-1.0 early release. The correctness core has
automated coverage across the supported databases, browser runtime, recovery
paths, and packaged artifact. There is one deployed first-party reference
application, no measured scale, and no known third-party production use yet.
Pre-1.0 is doing actual work in that sentence.

Solid Objects is released under the [MIT License](MIT-LICENSE). It is an
independent project and is not affiliated with or endorsed by Cloudflare.

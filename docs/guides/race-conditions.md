# Prevent race conditions in Node.js

A race condition in Node.js usually involves a read-modify-write sequence that spans an `await`. Fix most races in the database with one conditional statement, a constraint, or a transaction. Most applications do not need an actor library for this. Use one actor per contested identity when commands also come from jobs and reminders and must survive restarts.

## The failure: a lost update across an await

Node.js runs one callback at a time, but every `await` lets another request run. Two requests can read the same value before either request writes. The sequence from the first read to the final write does not run as one unit.

The example stores the available seat count in `seats` and each hold in `holds`. The test gives an event one available seat.

```typescript
import { DatabaseSync } from "node:sqlite"

export function openSeatInventory({
  path,
  eventId,
  available,
}: {
  path: string
  eventId: string
  available: number
}): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE IF NOT EXISTS seats (event_id TEXT PRIMARY KEY, available INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS holds (event_id TEXT NOT NULL, buyer TEXT NOT NULL);
  `)
  database
    .prepare("INSERT OR IGNORE INTO seats (event_id, available) VALUES (?, ?)")
    .run(eventId, available)
  return database
}

export function seatCounts({ database, eventId }: { database: DatabaseSync; eventId: string }): {
  available: number
  holds: number
} {
  const seats = database.prepare("SELECT available FROM seats WHERE event_id = ?").get(eventId) as {
    available: number
  }
  const holds = database
    .prepare("SELECT COUNT(*) AS count FROM holds WHERE event_id = ?")
    .get(eventId) as {
    count: number
  }
  return { available: seats.available, holds: holds.count }
}
```

The operation reads the count, then pauses at `await checkBuyer()`. Another request reads the same count during that pause. Each request subtracts one from its own copy of the count. Each request writes zero and inserts a hold.

```typescript
import type { DatabaseSync } from "node:sqlite"

export async function holdSeatWithRace({
  database,
  eventId,
  buyer,
  checkBuyer,
}: {
  database: DatabaseSync
  eventId: string
  buyer: string
  checkBuyer: () => Promise<void>
}): Promise<{ held: boolean }> {
  const row = database.prepare("SELECT available FROM seats WHERE event_id = ?").get(eventId) as {
    available: number
  }
  if (row.available === 0) return { held: false }

  await checkBuyer()

  database
    .prepare("UPDATE seats SET available = ? WHERE event_id = ?")
    .run(row.available - 1, eventId)
  database.prepare("INSERT INTO holds (event_id, buyer) VALUES (?, ?)").run(eventId, buyer)
  return { held: true }
}

export function createLocalMutex(): { run<Result>(task: () => Promise<Result>): Promise<Result> } {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<Result>(task: () => Promise<Result>): Promise<Result> {
      const result = tail.then(task)
      tail = result.catch(() => undefined)
      return result
    },
  }
}
```

The test starts with one seat left. Two concurrent calls to `holdSeatWithRace` both return `held: true`, and the table records two holds. The available count still reads zero. The count alone therefore does not reveal the extra hold.

## Why a mutex in one process does not help

A mutex makes calls wait for their turn. `createLocalMutex` serializes calls that share that mutex inside one process. It can protect a sequence that spans an `await` within that process.

Production can run several processes or containers. Each process has its own mutex, so a mutex in one process does not stop a call in another process.

The mutex test models two processes with two database connections and two mutexes. Both calls take the last seat. The test uses separate connections and mutexes within one test process. The actor test below uses two actual processes.

## Start with the database

The database can enforce a rule at the point where data changes. This often solves the whole problem. Choose the smallest database operation that enforces the rule.

| Problem                                                             | Start with                                                             | When an actor becomes relevant                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Duplicate records                                                   | A unique constraint                                                    | A larger lifecycle also needs ordered, durable work.                 |
| Concurrent decrement of a counter or stock                          | One conditional `UPDATE` in a transaction                              | The change forms part of holds, expiry, retries, and later commands. |
| Two people edit an old form                                         | A revision column that the `UPDATE` checks                             | The record also receives commands from jobs and reminders.           |
| Several rows change in one request                                  | One transaction with row locks (`SELECT ... FOR UPDATE` in PostgreSQL) | Work must continue after the transaction and survive failures.       |
| Commands for one identity arrive from requests, jobs, and reminders | An explicit coordination design                                        | This is the main case for an actor.                                  |

The database fix keeps the availability check and the decrement in one conditional `UPDATE`. The statement changes the count only when `available > 0`. The operation inserts a hold only when the statement changes a row.

```typescript
import type { DatabaseSync } from "node:sqlite"

export function holdSeatAtomically({
  database,
  eventId,
  buyer,
}: {
  database: DatabaseSync
  eventId: string
  buyer: string
}): { held: boolean } {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = database
      .prepare("UPDATE seats SET available = available - 1 WHERE event_id = ? AND available > 0")
      .run(eventId)
    if (result.changes === 0) {
      database.exec("ROLLBACK")
      return { held: false }
    }
    database.prepare("INSERT INTO holds (event_id, buyer) VALUES (?, ?)").run(eventId, buyer)
    database.exec("COMMIT")
    return { held: true }
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
```

In SQLite, `BEGIN IMMEDIATE` starts the write transaction at once, before the first write statement. See the [SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html). The transaction makes the conditional `UPDATE` and the insert commit together. If the operation fails, it rolls back the transaction. If the statement changes no row, the operation returns `held: false`.

In PostgreSQL or MySQL, the conditional `UPDATE ... WHERE available > 0` gives the same guarantee for the decrement in one statement. Keep the separate hold insert in the same transaction.

The test uses two connections to try the last seat. One hold succeeds, one fails, and the database records one hold with zero seats available. This test calls the synchronous operations in sequence across the two connections.

## When one statement is not enough

A seat hold has a lifecycle beyond the first request. A request holds a seat, a payment job confirms it, and a timer releases it after 10 minutes. These three sources can race. The process can restart before the timer fires.

The database fix protects the initial decrement. The application still needs rules for later commands and work that survives a restart. Solid Objects becomes relevant when one identity owns that state and needs ordered, durable work from all three sources.

## One actor owns the seats for one event

`EventSeats` keeps the capacity, holds, and sales for one event. It calculates availability from that state.

```typescript
import { Actor } from "solid-objects"

export const HOLD_MILLISECONDS = 10 * 60 * 1000

export type EventCaller = { userId: string; role: "buyer" | "organizer" | "system" }

type Hold = { buyer: string; expiresAt: number }

export class EventSeats extends Actor {
  static override readonly actorType = "EventSeats"

  capacity = 0
  revision = 0
  holds: Record<string, Hold> = {}
  sold: Record<string, string> = {}

  get available(): number {
    return this.capacity - Object.keys(this.holds).length - Object.keys(this.sold).length
  }

  setCapacity({ capacity, expectedRevision }: { capacity: number; expectedRevision: number }): {
    revision: number
  } {
    if (expectedRevision !== this.revision) {
      this.reject("stale_revision", {
        message: "The event changed after you loaded it",
        details: { revision: this.revision },
      })
    }
    if (capacity < this.capacity - this.available) {
      this.reject("capacity_below_sold", { message: "Holds and sales already use more seats" })
    }
    this.capacity = capacity
    this.revision += 1
    return { revision: this.revision }
  }

  hold({ holdId, buyer }: { holdId: string; buyer: string }): { held: boolean; available: number } {
    if (Object.hasOwn(this.holds, holdId) || Object.hasOwn(this.sold, holdId)) {
      return { held: true, available: this.available }
    }
    if (this.available === 0) return { held: false, available: 0 }

    const expiresAt = Date.now() + HOLD_MILLISECONDS
    this.holds = { ...this.holds, [holdId]: { buyer, expiresAt } }
    this.schedule({ at: new Date(expiresAt), key: holdId }).expire({ holdId })
    return { held: true, available: this.available }
  }

  confirm({ holdId }: { holdId: string }): { confirmed: boolean } {
    if (Object.hasOwn(this.sold, holdId)) return { confirmed: true }
    const hold = this.holds[holdId]
    if (!hold) {
      this.reject("hold_expired", { message: "The hold expired before the payment arrived" })
    }

    this.holds = withoutKey(this.holds, holdId)
    this.sold = { ...this.sold, [holdId]: hold.buyer }
    this.unschedule("expire", { key: holdId })
    return { confirmed: true }
  }

  expire({ holdId }: { holdId: string }): { expired: boolean } {
    if (!Object.hasOwn(this.holds, holdId)) return { expired: false }

    this.holds = withoutKey(this.holds, holdId)
    return { expired: true }
  }
}

function withoutKey<Value>(record: Record<string, Value>, key: string): Record<string, Value> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))
}
```

The actor identity is the event because the event owns the shared availability. One actor per hold still lets two holds take the same seat. Both holds need the same owner for the count.

Calls for one event run one at a time, in order, across processes. Different events can run at the same time. The boundary follows the event, regardless of which process receives a request.

`hold` checks `holdId` in both `holds` and `sold` before it takes another seat. A repeat for a recorded hold or sale returns `held: true` without another decrement. The repeated call in the test returns the same answer. The `available` getter reports the current count.

`schedule({ at, key: holdId }).expire({ holdId })` sets one reminder per hold. The reminder is durable and runs after a restart when the runtime resumes. Its due time is 10 minutes after the hold starts.

`confirm` moves the hold into `sold`. It cancels the reminder with `unschedule("expire", { key: holdId })`. Cancellation cannot recall a reminder that already became a message. `expire` does nothing when the hold is gone, so a late or repeated reminder is harmless.

`confirm` rejects an expired hold with the code `hold_expired`. Expiry changes the state when `expire` runs. The passage of 10 minutes alone does not remove the hold.

## Order alone does not stop a stale write

An old form can overwrite newer data even when calls run in order. The calls run in order, but the second call still carries old data. The actor needs a rule that detects this conflict.

`setCapacity` takes `expectedRevision` and compares it with `revision`. A mismatch rejects the change with `stale_revision`. An accepted capacity change increases the revision.

The test accepts a change from 10 seats to 12 seats. An old form then requests eight seats with the previous revision. The actor rejects that request and keeps the capacity at 12.

Keep revision checks or domain operations inside the actor. Order controls when a command runs. The operation still decides whether its arguments permit a valid change.

## Authorize every caller

All authorization callbacks deny by default. The example supplies policies for messages and queries.

```typescript
import { createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { EventSeats, type EventCaller } from "./event-seats.js"

const SYSTEM_OPERATIONS = new Set(["confirm", "expire"])

export function authorizeEventMessage({
  actorType,
  operation,
  authorizationContext,
}: {
  actorType: string
  operation: string
  authorizationContext: unknown
}): boolean {
  if (actorType !== EventSeats.actorType) return false
  if (!isEventCaller(authorizationContext)) return false
  if (operation === "setCapacity") return authorizationContext.role === "organizer"
  if (SYSTEM_OPERATIONS.has(operation)) return authorizationContext.role === "system"
  return true
}

export function authorizeEventQuery({
  actorType,
  authorizationContext,
}: {
  actorType: string
  authorizationContext: unknown
}): boolean {
  return actorType === EventSeats.actorType && isEventCaller(authorizationContext)
}

export function eventRuntime({ path }: { path: string }): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path }),
    authorizeMessage: authorizeEventMessage,
    authorizeQuery: authorizeEventQuery,
  })
  runtime.register(EventSeats)
  return runtime
}

function isEventCaller(value: unknown): value is EventCaller {
  if (typeof value !== "object" || value === null) return false
  if (!("userId" in value) || typeof value.userId !== "string") return false
  if (!("role" in value)) return false
  return value.role === "buyer" || value.role === "organizer" || value.role === "system"
}
```

The policy limits access to the `EventSeats` actor type and checks the caller context. Only an organizer can change capacity. Calls to `confirm` or `expire` require the `system` role, which the example assigns to the payment job. A reminder runs inside the runtime and needs no caller policy.

The example checks the role but does not bind a caller to a particular event. Bind the actor type and identity to the authenticated user or tenant in a production policy. An actor identity does not grant permission.

Pass the caller to `snapshot()` as `snapshot({ authorizationContext })`. For operation calls, pass the caller through `.with({ authorizationContext })`. A snapshot and an operation use different entry points for the context.

## Run the runtime process

Reminders, effects, and messages to other actors run only while a process calls `runtime.run(signal)`. Register each actor class before `run`. The example registers `EventSeats` when it creates the runtime.

When no process runs, committed work waits in the database. It runs later when a runtime process resumes. See [step 7 of the agent guide](../agents.md#7-run-the-background-roles).

In tests, call `runtime.testing.runDueReminders({ now })` to put due reminders in the queue. Then call `runtime.testing.drain({ roles: ["actors"] })` to run that work. These calls test expiry without a wait for the real deadline.

## What the tests prove

The [test file](../../test/guide-race-conditions.test.ts) checks these outcomes:

- Two processes attempt eight holds at the same time against a capacity of three. Only three holds succeed.
- A repeated hold applies once and leaves the same available count.
- A hold expires after a runtime restart when its reminder is due.
- A late expiry after a confirmation changes nothing.
- A confirmation after expiry rejects with `hold_expired`.
- A capacity change from a stale form rejects with `stale_revision`.
- A buyer cannot change capacity.

The assertions check both results and stored state. They show the behavior of these examples and their conflict cases.

## Limits and costs

Delivery is at least once. Write each operation so that it can run again. The runtime can retry work after a failure.

An external call, such as a payment or an email, belongs in an effect. Use the stable effect ID `context.id` as the provider idempotency key. This key lets the provider identify a repeat of the same effect. See [step 8 of the agent guide](../agents.md#8-make-external-effects-idempotent).

There are no transactions across two actor identities. One identity runs one write at a time. An event with many writes therefore has a throughput limit.

Each operation adds a message row. The runtime keeps completed messages for 30 days by default through `messageRetentionMilliseconds`. See [Configuration](../configuration.md#retention-and-cleanup) for retention and cleanup controls.

The package requires Node.js 24.4 or newer and supports ESM only. The package is pre-1.0. See [Correctness and delivery semantics](../correctness.md) and [Virtual actors in TypeScript and Node.js](../virtual-actors.md).

## Sources

[SQLite transaction documentation, BEGIN IMMEDIATE](https://www.sqlite.org/lang_transaction.html), checked October 9, 2026.

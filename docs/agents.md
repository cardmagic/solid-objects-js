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

The browser runtime has different requirements. See
[step 12](#12-use-the-browser-runtime).

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
- A reminder changes state only when it runs, and it runs only while a process
  calls `runtime.run(signal)`. Do not compute expiry from the clock in a query;
  read the state that the reminder committed.

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
- `solid-objects/browser` is a WebSocket client, not the SQL runtime. The
  browser runtime in step 12 is tested in Chromium only. The Cloudflare backend
  is experimental.

The [correctness contract](correctness.md) is the source for each guarantee.

## 12. Use the browser runtime

The same `Actor` classes run in a browser module worker. The database is SQLite
WASM. Persistent state is in the origin private file system (OPFS), so it
survives a page reload.

Use the browser runtime when one identity in the browser, such as a draft, a
game, or a form, must keep its state across reloads and tabs. It also fits
writes that must wait on the device until the network returns. Select a simpler
tool in these cases:

| Requirement                              | Use instead                                     |
| ---------------------------------------- | ----------------------------------------------- |
| A preference or another small value      | `localStorage`                                  |
| A cache of server responses              | The Cache API or IndexedDB                      |
| State that must be correct for all users | A server runtime. The user controls the browser |
| Live updates from a server runtime only  | `solid-objects/browser`, the WebSocket client   |

### Install

```bash
npm install solid-objects @sqlite.org/sqlite-wasm
```

`@sqlite.org/sqlite-wasm` 3.50 or newer is an optional peer dependency. The
browser runtime needs it.

### Choose the entry point

| Need                                            | Use                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The runtime in a worker                         | `solid-objects/browser/host`. It exports `Actor`, `configure`, `sqliteWasm`, `sharedSqliteWasm`, and the tab host |
| One database for all tabs, a worker in each tab | `sharedSqliteWasm({ path })`. Storage is persistent by default                                                    |
| One worker in one tab only                      | `sqliteWasm({ path, storage: "persistent" })`. The default storage is `"temporary"`                               |
| One runtime for all tabs, with a leader tab     | `startTabHost()` and `connectTabClient()` from `solid-objects/browser/tab-host`                                   |
| Send local writes to a server                   | `this.transmit()` and `registerTransmit()`. See [Send writes to a server](#send-writes-to-a-server)               |

### Example

This module worker hosts the runtime. Each tab starts one copy.
`sharedSqliteWasm` elects one tab to hold the database. The other tabs send
their SQL to that tab, and a new tab takes over when it closes.

```javascript
import { Actor, configure, sharedSqliteWasm } from "solid-objects/browser/host"

class NoteDraft extends Actor {
  static actorType = "NoteDraft"

  text = ""
  revision = 0

  edit({ text }) {
    this.text = text
    this.revision += 1
    return this.revision
  }
}

const allowNoteDrafts = ({ actorType }) => actorType === "NoteDraft"

const runtime = configure({
  database: sharedSqliteWasm({ path: "notes.db" }),
  authorizeMessage: allowNoteDrafts,
  authorizeQuery: allowNoteDrafts,
  processAliveThresholdMilliseconds: 750,
  leaseDurationMilliseconds: 750,
  leaseRenewalIntervalMilliseconds: 250,
})
runtime.register(NoteDraft)
const installed = runtime.install()
installed.then(() => runtime.run(new AbortController().signal))

self.onmessage = async (event) => {
  const { requestId, actorId, operation, argumentsValue } = event.data
  try {
    await installed
    const value = await NoteDraft.ref(actorId)[operation](argumentsValue)
    postMessage({ requestId, ok: true, value })
  } catch (error) {
    postMessage({ requestId, ok: false, message: String(error?.message ?? error) })
  }
}
```

The page sends messages to the worker. It does not hold actor references:

```javascript
const worker = new Worker(new URL("./draft-worker.js", import.meta.url), { type: "module" })
const pending = new Map()
let nextRequestId = 0
let workerFailure

worker.onmessage = (event) => {
  const { requestId, ok, value, message } = event.data
  const request = pending.get(requestId)
  pending.delete(requestId)
  if (ok) {
    request.resolve(value)
    return
  }
  request.reject(new Error(message))
}

worker.onerror = (event) => {
  workerFailure = new Error(`The actor worker failed: ${event.message || "it did not load"}`)
  for (const request of pending.values()) request.reject(workerFailure)
  pending.clear()
}

export function callActor({ actorId, operation, argumentsValue }) {
  if (workerFailure) return Promise.reject(workerFailure)
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    worker.postMessage({ requestId, actorId, operation, argumentsValue })
  })
}
```

CI runs this example in Chromium. It checks that state survives a reload, that
two tabs share one draft, and that the second tab continues after the first
tab closes.

A closed tab does not shut down its runtime. Keep the short lease settings in
the example. With the default settings, the next tab waits for the old lease,
and calls time out before it expires.

### Authorize in the browser

The page and the worker run on the user's device, and the user can change
their code. A browser policy limits what your own page can call. It is not a
security boundary. Authorize again on the server for each write that leaves the
device.

### Rules for browser actors

- One worker hosts one runtime. Do not import `solid-objects/browser/host` in
  a process that also imports the Node.js entry points.
- After the first `await` in an operation, `currentActor()`,
  `applicationWritesForbidden()`, and the database deadline read as unset. Keep
  guarded writes in synchronous actor code or in commit actions.
- Reminders and effects run only while a worker that calls
  `runtime.run(signal)` is alive. When the user closes every tab, nothing runs.
- With `sharedSqliteWasm`, a statement can fail with `SharedDatabaseFailover`
  when the holder tab closes during the statement. Write operations so that
  they can run again, and retry the call.
- With `startTabHost()`, close the database in a `catch` block when
  `startRuntime` fails. An open database blocks the next tab.

### Platform limits

- CI tests the browser runtime in Chromium only. Safari 16.4 and Firefox 111
  added the OPFS API that persistent storage needs. Test on each engine that
  you support.
- Persistent storage needs a secure context (HTTPS or `localhost`) and a
  dedicated worker. `storage: "persistent"` fails fast where OPFS is missing.
- An embedded WebView, such as Cordova, WKWebView, or Android WebView, can lack
  OPFS when the device browser has it. Test the WebView itself.
- The browser can clear the storage of an origin. Call
  `navigator.storage.persist()` to ask it to keep the data, and send important
  writes to a server.

### Send writes to a server

An operation stages a write for the server in the same transaction as its
state change:

```javascript
this.transmit().edit({ text })
```

`registerTransmit({ runtime, deliver })` sends each staged write to the server.
The runtime does not read the HTTP response. Your `deliver` callback decides
what happens:

```javascript
import { NonRetryableError } from "solid-objects/core"
import { registerTransmit } from "solid-objects/browser/host"

registerTransmit({
  runtime,
  deliver: async (envelope) => {
    const response = await fetch("/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    })
    if (response.status === 422) {
      throw new NonRetryableError(`The server rejected effect ${envelope.effectId}`)
    }
    if (!response.ok) throw new Error(`Sync failed with HTTP ${response.status}`)
  },
})
```

- A normal return marks the write as delivered.
- An `Error` makes the effect try again later. This is the offline case.
- A `NonRetryableError` moves the effect to dead letters with no retry.

Set a high `maxAttempts` in `configure()`, because the default is 5 and a long
offline period can use all attempts. Run one effect worker for each local
runtime to keep the order of writes for each actor.

The server receives the write with `receiveTransmitEnvelope({ runtime, envelope })`
in Node.js, or with `SolidObjects::Transmission.receive(envelope)` in Rails.
Authenticate the device before this call, because this delivery skips
`authorizeMessage`. Delivery is at least once. The server applies a repeated
write once, because it uses the effect ID as the idempotency key. In Node.js,
return HTTP 422 for `InvalidPayload` and `IdempotencyConflict`. The `deliver`
callback above turns that status into a `NonRetryableError`, so the device
stops the retries.

The [public API](api.md#solid-objectstransmit) and the
[browser protocol](browser-protocol.md) give the full contract.

### Verify a browser implementation

1. Call an operation, reload the page, and confirm that the state is the same.
2. Send concurrent calls to one identity from two tabs. Assert the final state.
3. Close the tab that holds the database. Confirm that the other tab continues.
4. On each target engine, confirm that persistent storage opens, or fails with
   a clear error.
5. If you send writes to a server, confirm that the server rejects a device
   that it cannot authenticate, and applies a repeated write once.

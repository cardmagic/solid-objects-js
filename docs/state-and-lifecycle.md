# State and lifecycle

An actor class is both the persisted state definition and the typed operation
surface. Registration constructs the class to discover its enumerable public
fields, then walks its prototype chain to discover methods and getters.

## Persisted state and operations

- Enumerable public instance fields are persisted JSON state.
- Public methods are ordered operations and accept zero arguments or one
  object argument.
- Public fields and getters are ordered, read-only queries on a reference.
- `#private` fields are process-local and survive only while an activation is
  cached.
- Actor arguments, state, results, observables, and payloads must be
  JSON-compatible and fit their configured byte limits.
- Operation, field, and getter names must not collide with the reference API.

The constructor must establish every persisted field and must not depend on
external state. Solid Objects invokes it at four points: class validation,
default creation, state hydration, and snapshot projection. Because the
constructor must not depend on external state, the runtime computes the default
state once for each registered class and gives each caller a detached copy.

## State size and throughput

Solid Objects commits the whole state image on each turn. The turn therefore
reads, encodes, and writes every persisted field, and its cost grows with the
size of the state rather than with the size of the change.

Measured on August 29, 2026 on an Apple M5, macOS 26.6, Node.js 24.18.0, and
SQLite 3.53.1 through `node:sqlite`. One actor, one `increment()` operation,
sequential turns, 300 measured operations per row, and the `0.14.3` source tree
with the serialization changes applied.

| Persisted state | ms per operation | Operations per second |
| --------------: | ---------------: | --------------------: |
|            0 KB |             1.60 |                   625 |
|           16 KB |             1.64 |                   611 |
|          128 KB |             2.53 |                   395 |
|            1 MB |             9.32 |                   107 |

These are developer-laptop numbers. They show the shape of the curve, not a
capacity guarantee. See [Benchmarks](benchmarks.md#large-state) for the harness
and the earlier numbers.

Keep one actor's state small, and divide a large state across more identities.
`warnStateBytes` reports one `solid_objects.state.large` instrumentation event
when a committed image passes its threshold, which defaults to 128 KB.
`maxStateBytes` is the hard limit, and it fails the turn.

## Observable broadcast modes

`observables()` defines the named values used for realtime change detection.
Unwrapped values are invalidation-only: the runtime compares their real values
but includes only each changed name in committed envelopes. Wrapping a value in
`broadcastInvalidation()` makes that contract explicit. Wrap it in
`broadcastValue()` only when every authorized actor subscriber may receive the
value itself. Every mode evaluates and JSON-validates its real value after a
successful turn.

## State migrations

Every actor starts at state version 1. Increase `stateVersion` when existing
rows need a structural transformation and retain an adjacent migration for
every version:

```typescript
import { Actor, type JsonObject } from "solid-objects"

class Document extends Actor {
  static override readonly actorType = "Document"
  static override readonly stateVersion = 3
  static override readonly migrations = [
    {
      from: 1,
      to: 2,
      migrate: (state: JsonObject): JsonObject => ({
        title: state.name ?? "Untitled",
      }),
    },
    {
      from: 2,
      to: 3,
      migrate: (state: JsonObject): JsonObject => ({
        ...state,
        archived: false,
      }),
    },
  ]

  title = "Untitled"
  archived = false
}
```

Migrations run synchronously in ascending order when an actor is hydrated for
an operation, snapshot, reconciliation state read, observable replay, or
personalized payload. Each receives a detached JSON object and must return a
JSON object. After the chain completes, any new persisted field missing from
the result receives its constructor default. Migrated state is persisted only
by the next successful fenced operation commit; read-only projections do not
rewrite the row.

A migration must be deterministic and side-effect free. It cannot perform
asynchronous work or write through a database wrapped by
`guardApplicationDatabase()`. Missing, duplicate, or non-adjacent migrations,
a failing migration, or state newer than the running code raises
`StateMigrationError`.

For a destructive shape change, use an expand/contract deployment:

1. deploy readers that understand both shapes;
2. deploy the migration;
3. wait for operational evidence that the actors advanced;
4. remove the old-shape support.

If old code cannot understand the new shape, drain it before new code persists
the migration. Keep the old migration steps. An actor that stays idle for
several releases can then still advance one version at a time.

Actor state migration is separate from `runtime.install()`. The latter applies
the package's relational schema migrations; it does not eagerly rewrite actor
state.

## Activation lifecycle

Override `onActivate()` and `onDeactivate()` for process-local resources:

```typescript
class Device extends Actor {
  static override readonly actorType = "Device"

  #connection: DeviceConnection | undefined

  protected override async onActivate(): Promise<void> {
    this.#connection = await connectToDevice(this.actorId)
  }

  protected override async onDeactivate(): Promise<void> {
    await this.#connection?.close()
    this.#connection = undefined
  }
}
```

Activation happens after state migration and before an operation attempt
starts. A setup failure restores the claimed message without consuming an
attempt. A long-running worker may reuse the hydrated actor and its private
fields until `idleDeactivationTimeoutMilliseconds`, fairness yield, lease loss,
or shutdown.

Lifecycle hooks have no `currentMessage` and run under the application-write
guard. Intents staged by `onActivate()` join the first turn's commit; use that
only when reactivation should repeat the intent safely. `onDeactivate()` is
best effort, its staged intents are discarded, and it may not run after a
crash, so it cannot establish correctness.

## Domain rejection and failure

Call `this.reject(code, { message, details })` when an operation is valid but
the domain refuses it. Codes use the same identifier rule as actor members:
`[A-Za-z_][A-Za-z0-9_]*`. The turn rolls back, staged work is discarded, the
message becomes `rejected`, and later mailbox work remains eligible. The caller
receives `Rejected` with the code, frozen JSON details, and durable message ID.

Throwing another error rolls the turn back and schedules a retry according to
`maxAttempts` and `retryDelayMilliseconds`. Throw a custom subclass of
`NonRetryableError` only when retry cannot help; the message goes directly to a
terminal dead letter. See [Errors and recovery](errors-and-recovery.md).

## Queries and snapshots

Reading a public field or getter through an actor reference is an ordered
mailbox query:

```typescript
const count = await Counter.ref("primary").count
```

Use `snapshot()` when the read need not wait behind mailbox work:

```typescript
const snapshot = await Counter.ref("primary").snapshot({
  authorizationContext: currentUser,
})
```

Both paths call `authorizeQuery`. A snapshot hydrates one committed state
image, returns all fields and getters as a deeply frozen value, and never adds
a message to history. A getter that mutates state or stages work raises
`QueryMutatedState` for the whole snapshot.

## Destruction and reincarnation

`reference.destroy()` calls the separate `authorizeDestroy` policy, deletes
the current actor incarnation and every owned row, and returns `true` when an
incarnation existed. Repeating it returns `false`.

An actor cannot destroy another actor from inside a turn. A later message to
the same actor type and ID creates a new instance ID and revision sequence.
Old activation leases cannot commit to the new incarnation, and an authorized
caller waiting on the deleted incarnation receives `ActorDestroyed`. An
external effect or broadcast already executing cannot be recalled, but its
stale completion cannot recreate or enqueue a callback to the deleted source.

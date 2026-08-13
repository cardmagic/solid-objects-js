# Ruby parity ledger

This ledger tracks spiritual feature parity with the Ruby `solid_objects` gem.
Parity means preserving a capability and its correctness or security boundary,
not copying a Rails API into Node.

Reference: Ruby `solid_objects` 0.12.0 at commit `a01b6f5`.

The Node `0.12.1` implementation has spiritual parity with that reference. Its
relational runtime, correctness boundaries, administration, diagnostics,
realtime projections, browser behavior, and supported adapters have native
equivalents. Rails engine and rendering surfaces are intentionally replaced by
transport- and framework-neutral JavaScript APIs. The partial guard row and the
shared planned result-lookup row below are explicit scope boundaries, not
missing Ruby capabilities.

## Status vocabulary

- **Native**: the TypeScript runtime provides the capability in a Node-native
  shape.
- **Partial**: the core exists, but an important Ruby guarantee or operational
  surface is missing.
- **Planned**: no defensible equivalent exists yet.
- **Not applicable**: the Ruby feature belongs specifically to Rails, Active
  Record, Action Cable, Turbo, or Ruby language constraints. The equivalent
  Node capability is tracked separately when one is useful.

## Runtime and correctness

| Capability                                                                                                    | Status  | TypeScript shape or remaining work                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actor registry, durable identity, JSON state, and adjacent state migrations                                   | Native  | Ordinary classes, static actor types, inferred state, explicit migrations, and isolated runtime context across every actor-instance callback.                                                                      |
| Fluent committed calls and background delivery                                                                | Native  | `await reference.operation()` and `reference.send.operation()`.                                                                                                                                                    |
| Ordered mailbox, sequence allocation, idempotency, retries, dead letters, leases, renewal, and fenced commits | Native  | Relational ready/claimed membership tables, distinct generated request IDs and caller idempotency keys, durable history, and adapter-appropriate sequence locking.                                                 |
| Domain rejection and strict poison ordering                                                                   | Native  | Rejections accept JavaScript identifier-style codes and roll back without retry; invalid codes fail terminally, while retryable failures block later operations until completion or dead-lettering.                |
| Bounded activation passes and hot-actor fairness                                                              | Native  | Configurable turn-count and elapsed-time budgets bound each pass, then move only that actor's already-due memberships behind actors already waiting.                                                               |
| Bounded claim candidate scan                                                                                  | Native  | A configurable ordered scan continues to another ready actor when a worker loses the first candidate's lease race.                                                                                                 |
| Idle activation cache                                                                                         | Native  | Long-running workers retain hydrated actors under renewable fenced leases, restore public state after failed turns, and release on timeout, fairness yield, lease loss, or shutdown.                               |
| Transactional effects and outcome operations                                                                  | Native  | At-least-once handlers receive immutable stable effect, attempt, source-message, and actor identity; success and failure operations also receive the originally staged arguments for correlation.                  |
| Actor-to-actor delivery                                                                                       | Native  | `sendTo(reference).operation()` stages delivery in the source actor commit.                                                                                                                                        |
| One-shot and recurring reminders                                                                              | Native  | Scheduling, replacement events, catch-up policy, stale-claim recovery, pausing, authorized inspection, and idempotent resume are implemented.                                                                      |
| Same-database commit actions                                                                                  | Native  | Registered actions receive source-message identity, mailbox sequence, activation generation, and the fenced transaction connection.                                                                                |
| Ambient transaction rejection                                                                                 | Native  | Committed calls and message waits fail before blocking when the current async context already owns a transaction on the Solid Objects adapter.                                                                     |
| Direct application-write isolation during actor code                                                          | Partial | `guardApplicationDatabase()` fails closed for operations, projections, migrations, and commit actions; only the supplied fenced commit-action connection may write. Unwrapped clients cannot be intercepted.       |
| Committed snapshots                                                                                           | Native  | `snapshot()` returns authorized persisted fields and inferred getters from one read-only committed state image; realtime replay reads explicit observables without mailbox history.                                |
| Actor destruction and incarnation fencing                                                                     | Native  | Authorized cascading deletion creates a fresh instance ID on recreation; an authorized waiter receives `ActorDestroyed` when that incarnation disappears.                                                          |
| Result recovery and sync timeout diagnostics                                                                  | Native  | Status, result, and wait reauthorize the stored operation; terminal failure raises structured `MessageFailed`; whole-call adapter deadlines distinguish enqueue, wait, database, activation, and mailbox blockers. |
| Result lookup by request ID                                                                                   | Planned | This is also an open Ruby roadmap item and will be implemented in both runtimes when its authorization shape is settled.                                                                                           |

## Operations

| Capability                                                                    | Status | TypeScript shape or remaining work                                                                                                                                             |
| ----------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process registration, heartbeats, stale claim recovery, and graceful shutdown | Native | Runtime roles persist host, PID, runtime versions, draining and stopped transitions, cooperative cancellation, and a bounded shutdown deadline; cleanup recovers stale claims. |
| Failed-role replacement                                                       | Native | Built-in and registered roles are rebuilt through their factories with capped backoff; shutdown is the terminal replacement boundary.                                          |
| Additional supervised components                                              | Native | `registerComponent()` builds, validates, runs, and stops application components with the runtime.                                                                              |
| Dead-letter inspection and retry                                              | Native | `runtime.deadLetters` provides deny-by-default immutable inspection and idempotent durable retry linkage.                                                                      |
| Reconciliation reads                                                          | Native | Authorized cursor pages cover active, quiet, and orphaned instances; bounded state batches are migrated and deeply frozen.                                                     |
| Message, process, and opt-in instance retention                               | Native | Supervised scheduling bounds message and process growth; authorized manual APIs add preview and keep destructive instance expiration explicit.                                 |
| Doctor and schema verification                                                | Native | Structured checks cover configuration, schema/version shape, adapter server versions, neutral-context policy probes, live roles, and a targeted round trip.                    |
| CLI                                                                           | Native | The packaged executable loads an application runtime and exposes start, diagnostics, processes, dead letters, reminders, and explicit retention pruning as JSON.               |
| Structured instrumentation                                                    | Native | An isolated transport-neutral sink emits immutable lifecycle metadata and structurally excludes application payloads.                                                          |
| Public test helper                                                            | Native | `runtime.testing` provides role-selective deterministic draining, explicit-time due-reminder execution, and dependency-ordered reset without relying on cascades.              |

## Databases and wake-up

| Capability               | Status | TypeScript shape or remaining work                                                                                                                                                      |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite                   | Native | Uses built-in `node:sqlite`, serialized process-local access, bounded transient writer retries, foreign keys, strict tables, database time, and deadline-bounded access and lock waits. |
| PostgreSQL               | Native | Optional `pg` 8.23 peer, bounded pooling, 64-bit schema, row-locked sequences, server checks, and deadline-bounded pool, statement, and lock waits.                                     |
| MySQL                    | Native | Optional `mysql2` 3.23 peer, bounded pooling, InnoDB schema, row-locked sequences, scoped deadlock retry, and deadline-bounded pool, query, and lock waits.                             |
| Durable polling fallback | Native | Every role progresses without a notification service.                                                                                                                                   |
| In-process wake-up       | Native | A generation-based default adapter prevents claim-to-wait signal loss; commits wake role-specific waiters and polling remains the fallback.                                             |
| PostgreSQL wake-up       | Native | `database.wakeUp()` uses one dedicated event-driven client, role-specific `LISTEN/NOTIFY`, generation fencing, reconnectable listeners, and durable polling fallback.                   |
| Redis wake-up            | Native | An optional `redis` peer provides role-specific Pub/Sub over separate lazy publisher/subscriber connections, with bounded failures and durable polling fallback.                        |

## Realtime and browser behavior

| Capability                                                   | Status         | TypeScript shape or remaining work                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit observable projection and durable invalidations     | Native         | `observables()` is opt-in; changed values enter invalidation envelopes and are visible to every authorized subscriber. Unlike Ruby morph refreshes, values cross the wire, so private or subscriber-specific state belongs in payloads or reauthorized component endpoints. |
| Action Cable channels and signed stream names                | Not applicable | `runtime.realtime` provides authenticated transport-neutral sessions; the host owns its HTTP/WebSocket server and authentication.                                                                                                                                           |
| Authorized subscriptions                                     | Native         | Each request is denied by default and authorized before actor lookup; sessions replay committed observables and fence ordered durable revisions. Multi-process hosts explicitly bridge their shared transport.                                                              |
| Turbo scalar replacement                                     | Not applicable | The browser client exposes invalidations to application rendering code. Framework adapters can be separate packages.                                                                                                                                                        |
| Keyed component refresh, morph/replace, and batch coalescing | Native         | A typed framework-neutral registry selects explicit dependencies, coalesces batch requests, aborts superseded work, fences each target, and delegates synchronous application strategy to the host.                                                                         |
| Personalized payload broadcasts                              | Native         | Static typed projections run against committed state under each fresh subscriber context, reauthorize as queries, isolate failures, and carry independent revision fences.                                                                                                  |
| Real-browser compatibility suite                             | Native         | Playwright exercises subscription replay over native WebSocket, incarnation/revision fences, payload delivery, component batching, and cancellation in Chromium.                                                                                                            |

## Rails-specific surfaces

The Rails engine, generators, Active Record models/controllers, ERB helpers,
Turbo renderer, and Action Cable channel are not copied into this package.
Their underlying runtime, administration, authorization, and realtime
capabilities are represented above by Node-native APIs and protocols.

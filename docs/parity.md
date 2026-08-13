# Ruby parity ledger

This ledger tracks spiritual feature parity with the Ruby `solid_objects` gem.
Parity means preserving a capability and its correctness or security boundary,
not copying a Rails API into Node.

Reference: Ruby `solid_objects` 0.12.0 at commit `a01b6f5`.

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

| Capability                                                                                                    | Status  | TypeScript shape or remaining work                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor registry, durable identity, JSON state, and adjacent state migrations                                   | Native  | Ordinary classes, static actor types, inferred state, and explicit migrations.                                                                                                                             |
| Fluent committed calls and background delivery                                                                | Native  | `await reference.operation()` and `reference.send.operation()`.                                                                                                                                            |
| Ordered mailbox, sequence allocation, idempotency, retries, dead letters, leases, renewal, and fenced commits | Native  | Relational ready/claimed membership tables, durable history, and adapter-appropriate sequence locking.                                                                                                     |
| Domain rejection and strict poison ordering                                                                   | Native  | Rejections roll back without retry; retryable failures block later operations until completion or dead-lettering.                                                                                          |
| Bounded activation passes and hot-actor fairness                                                              | Native  | Workers preferentially drain one actor to a configurable cap, then move only its already-due memberships behind actors already waiting.                                                                    |
| Idle activation cache                                                                                         | Planned | Add short-lived hydrated actor reuse with lease renewal and pressure eviction without weakening fenced commits.                                                                                            |
| Transactional effects and outcome operations                                                                  | Native  | At-least-once effect handlers with stable IDs and success/failure actor operations.                                                                                                                        |
| Actor-to-actor delivery                                                                                       | Native  | `sendTo(reference).operation()` stages delivery in the source actor commit.                                                                                                                                |
| One-shot and recurring reminders                                                                              | Native  | Scheduling, replacement events, catch-up policy, stale-claim recovery, pausing, authorized inspection, and idempotent resume are implemented.                                                              |
| Same-database commit actions                                                                                  | Native  | Registered actions receive the fenced transaction connection.                                                                                                                                              |
| Direct application-write isolation during actor code                                                          | Partial | `guardApplicationDatabase()` fails closed for operations, projections, and migrations, while registered commit actions remain writable. Unwrapped ORM pools and third-party clients cannot be intercepted. |
| Committed snapshots                                                                                           | Native  | `snapshot()` returns authorized committed state; realtime replay reads the explicit observable projection with instance ID and revision without creating mailbox history.                                  |
| Actor destruction and incarnation fencing                                                                     | Native  | Authorized cascading deletion creates a fresh instance ID on recreation.                                                                                                                                   |
| Result recovery by message reference                                                                          | Native  | Status, result, and wait reauthorize the original stored operation.                                                                                                                                        |
| Result lookup by request ID                                                                                   | Planned | This is also an open Ruby roadmap item and will be implemented in both runtimes when its authorization shape is settled.                                                                                   |

## Operations

| Capability                                                                    | Status | TypeScript shape or remaining work                                                                                                                               |
| ----------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process registration, heartbeats, stale claim recovery, and graceful shutdown | Native | Runtime roles persist process state and release ownership on shutdown; authorized inspection and cleanup recover every stale claim type.                         |
| Failed-role replacement                                                       | Native | Built-in and registered roles are rebuilt through their factories with capped backoff; shutdown is the terminal replacement boundary.                            |
| Additional supervised components                                              | Native | `registerComponent()` builds, validates, runs, and stops application components with the runtime.                                                                |
| Dead-letter inspection and retry                                              | Native | `runtime.deadLetters` provides deny-by-default immutable inspection and idempotent durable retry linkage.                                                        |
| Reconciliation reads                                                          | Native | Authorized cursor pages cover active, quiet, and orphaned instances; bounded state batches are migrated and deeply frozen.                                       |
| Message, process, and opt-in instance retention                               | Native | Authorized preview and bounded prune APIs preserve live work and support default, per-actor, and opt-in policies.                                                |
| Doctor and schema verification                                                | Native | Structured checks cover configuration, schema/version shape, adapter server versions, policy posture, live roles, and a targeted round trip.                     |
| CLI                                                                           | Native | The packaged executable loads an application runtime and exposes start, diagnostics, processes, dead letters, reminders, and explicit retention pruning as JSON. |
| Structured instrumentation                                                    | Native | An isolated transport-neutral sink emits immutable lifecycle metadata and structurally excludes application payloads.                                            |
| Public test helper                                                            | Native | `runtime.testing` provides role-selective deterministic draining and dependency-ordered reset without relying on cascades.                                       |

## Databases and wake-up

| Capability               | Status | TypeScript shape or remaining work                                                                                                                                     |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite                   | Native | Uses built-in `node:sqlite`, serialized process-local access, foreign keys, strict tables, and database time.                                                          |
| PostgreSQL               | Native | Optional `pg` 8.23 peer, bounded pooling, 64-bit schema, row-locked sequence allocation, portable set queries, server checks, and a real PostgreSQL integration suite. |
| MySQL                    | Native | Optional `mysql2` 3.23 peer, bounded pooling, InnoDB schema, row-locked sequence allocation, scoped deadlock retry, diagnostics, and MySQL 8.0/8.4 integration suites. |
| Durable polling fallback | Native | Every role progresses without a notification service.                                                                                                                  |
| In-process wake-up       | Native | A generation-based default adapter prevents claim-to-wait signal loss; commits wake role-specific waiters and polling remains the fallback.                            |
| PostgreSQL wake-up       | Native | `database.wakeUp()` uses one dedicated event-driven client, role-specific `LISTEN/NOTIFY`, generation fencing, reconnectable listeners, and durable polling fallback.  |
| Redis wake-up            | Native | An optional `redis` peer provides role-specific Pub/Sub over separate lazy publisher/subscriber connections, with bounded failures and durable polling fallback.       |

## Realtime and browser behavior

| Capability                                                   | Status         | TypeScript shape or remaining work                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit observable projection and durable invalidations     | Native         | `observables()` is opt-in; only changed projected values enter the broadcast outbox.                                                                                                                           |
| Action Cable channels and signed stream names                | Not applicable | `runtime.realtime` provides authenticated transport-neutral sessions; the host owns its HTTP/WebSocket server and authentication.                                                                              |
| Authorized subscriptions                                     | Native         | Each request is denied by default and authorized before actor lookup; sessions replay committed observables and fence ordered durable revisions. Multi-process hosts explicitly bridge their shared transport. |
| Turbo scalar replacement                                     | Not applicable | The browser client exposes invalidations to application rendering code. Framework adapters can be separate packages.                                                                                           |
| Keyed component refresh, morph/replace, and batch coalescing | Native         | A typed framework-neutral registry selects explicit dependencies, coalesces batch requests, aborts superseded work, fences each target, and delegates synchronous application strategy to the host.            |
| Personalized payload broadcasts                              | Native         | Static typed projections run against committed state under each fresh subscriber context, reauthorize as queries, isolate failures, and carry independent revision fences.                                     |
| Real-browser compatibility suite                             | Native         | Playwright exercises subscription replay over native WebSocket, incarnation/revision fences, payload delivery, component batching, and cancellation in Chromium.                                               |

## Rails-specific surfaces

The Rails engine, generators, Active Record models/controllers, ERB helpers,
Turbo renderer, and Action Cable channel are not copied into this package.
Their underlying runtime, administration, authorization, and realtime
capabilities are represented above by Node-native APIs and protocols.

# Ruby parity ledger

This ledger tracks spiritual feature parity with the Ruby `solid_objects` gem.
Parity means preserving a capability and its correctness or security boundary,
not copying a Rails API into Node.

Reference: Ruby `solid_objects` 0.12.0 at commit `4cf22c1`.

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

| Capability                                                                                                    | Status  | TypeScript shape or remaining work                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor registry, durable identity, JSON state, and adjacent state migrations                                   | Native  | Ordinary classes, static actor types, inferred state, and explicit migrations.                                                                                                                                |
| Fluent committed calls and background delivery                                                                | Native  | `await reference.operation()` and `reference.send.operation()`; JavaScript needs no Ruby-style public sync/async split.                                                                                       |
| Ordered mailbox, sequence allocation, idempotency, retries, dead letters, leases, renewal, and fenced commits | Native  | SQLite-backed ready/claimed membership tables and durable message history.                                                                                                                                    |
| Domain rejection and strict poison ordering                                                                   | Native  | Rejections roll back without retry; retryable failures block later operations until completion or dead-lettering.                                                                                             |
| Activation passes, hot-actor fairness, and idle activation cache                                              | Planned | Workers currently claim one turn per pass. Add bounded consecutive turns without allowing a hot actor to monopolize a worker.                                                                                 |
| Transactional effects and outcome operations                                                                  | Native  | At-least-once effect handlers with stable IDs and success/failure actor operations.                                                                                                                           |
| Actor-to-actor delivery                                                                                       | Native  | `sendTo(reference).operation()` stages delivery in the source actor commit.                                                                                                                                   |
| One-shot and recurring reminders                                                                              | Native  | Scheduling, replacement events, catch-up policy, stale-claim recovery, pausing, authorized inspection, and idempotent resume are implemented.                                                                 |
| Same-database commit actions                                                                                  | Native  | Registered actions receive the fenced transaction connection.                                                                                                                                                 |
| Direct application-write isolation during actor code                                                          | Partial | Commit actions establish the supported write path, but Node cannot intercept arbitrary third-party database clients. Add an opt-in guarded application-database facade and document the enforcement boundary. |
| Committed snapshots                                                                                           | Native  | `snapshot()` returns authorized committed state; realtime replay reads the explicit observable projection with instance ID and revision without creating mailbox history.                                     |
| Actor destruction and incarnation fencing                                                                     | Native  | Authorized cascading deletion creates a fresh instance ID on recreation.                                                                                                                                      |
| Result recovery by message reference                                                                          | Native  | Status, result, and wait reauthorize the original stored operation.                                                                                                                                           |
| Result lookup by request ID                                                                                   | Planned | This is also an open Ruby roadmap item and will be implemented in both runtimes when its authorization shape is settled.                                                                                      |

## Operations

| Capability                                                                    | Status  | TypeScript shape or remaining work                                                                                                  |
| ----------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Process registration, heartbeats, stale claim recovery, and graceful shutdown | Native  | Runtime roles persist process state and release ownership on shutdown.                                                              |
| Failed-role replacement                                                       | Partial | A role failure currently stops the runtime. Add supervised replacement with bounded backoff and explicit terminal shutdown.         |
| Additional supervised components                                              | Native  | `registerComponent()` builds, validates, runs, and stops application components with the runtime.                                   |
| Dead-letter inspection and retry                                              | Native  | `runtime.deadLetters` provides deny-by-default immutable inspection and idempotent durable retry linkage.                           |
| Reconciliation reads                                                          | Native  | Authorized cursor pages cover active, quiet, and orphaned instances; bounded state batches are migrated and deeply frozen.          |
| Message, process, and opt-in instance retention                               | Native  | Authorized preview and bounded prune APIs preserve live work and support default, per-actor, and opt-in policies.                   |
| Doctor and schema verification                                                | Native  | Structured checks cover configuration, schema/version shape, SQLite version, policy posture, live roles, and a targeted round trip. |
| CLI                                                                           | Planned | Add Node commands for run, status, cleanup, doctor, dead letters, retry, and preview/execute pruning.                               |
| Structured instrumentation                                                    | Native  | An isolated transport-neutral sink emits immutable lifecycle metadata and structurally excludes application payloads.               |
| Public test helper                                                            | Native  | `runtime.testing` provides role-selective deterministic draining and dependency-ordered reset without relying on cascades.          |

## Databases and wake-up

| Capability                   | Status  | TypeScript shape or remaining work                                                                                                             |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite                       | Native  | Uses built-in `node:sqlite`, serialized process-local access, foreign keys, strict tables, and database time.                                  |
| PostgreSQL                   | Planned | Add a driver-neutral pool interface, PostgreSQL schema, locking behavior, integration suite, and server checks.                                |
| MySQL                        | Planned | Add a driver-neutral pool interface, MySQL schema, locking behavior, integration suite, engine/version checks, and client compatibility tests. |
| Durable polling fallback     | Native  | Every role progresses without a notification service.                                                                                          |
| In-process wake-up           | Native  | A generation-based default adapter prevents claim-to-wait signal loss; commits wake role-specific waiters and polling remains the fallback.    |
| PostgreSQL and Redis wake-up | Planned | Add optional adapters; neither may become a hidden required dependency.                                                                        |

## Realtime and browser behavior

| Capability                                                   | Status         | TypeScript shape or remaining work                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit observable projection and durable invalidations     | Native         | `observables()` is opt-in; only changed projected values enter the broadcast outbox.                                                                                                                           |
| Action Cable channels and signed stream names                | Not applicable | `runtime.realtime` provides authenticated transport-neutral sessions; the host owns its HTTP/WebSocket server and authentication.                                                                              |
| Authorized subscriptions                                     | Native         | Each request is denied by default and authorized before actor lookup; sessions replay committed observables and fence ordered durable revisions. Multi-process hosts explicitly bridge their shared transport. |
| Turbo scalar replacement                                     | Not applicable | The browser client exposes invalidations to application rendering code. Framework adapters can be separate packages.                                                                                           |
| Keyed component refresh, morph/replace, and batch coalescing | Planned        | Add a framework-neutral refresh registry and browser batching/cancellation protocol; DOM application remains adapter-owned.                                                                                    |
| Personalized payload broadcasts                              | Planned        | Add subscriber-specific projections evaluated under a fresh host authorization context, isolated so one projection failure cannot stop siblings.                                                               |
| Real-browser compatibility suite                             | Planned        | Exercise reconnection, incarnation changes, stale revisions, cancellation, batching, and payload delivery in Chromium.                                                                                         |

## Rails-specific surfaces

The Rails engine, generators, Active Record models/controllers, ERB helpers,
Turbo renderer, and Action Cable channel are not copied into this package.
Their underlying runtime, administration, authorization, and realtime
capabilities are represented above by Node-native APIs and protocols.

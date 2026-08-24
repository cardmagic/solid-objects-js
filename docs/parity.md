# Design parity ledger

This ledger tracks capability parity with the Ruby `solid_objects` gem.
Parity means preserving a capability and its correctness or security boundary,
not copying a Rails API into Node.

Reference: Ruby `solid_objects` 0.14.0. The JavaScript package began at the
Ruby design's `0.12` capability generation; that version number did not imply
earlier JavaScript releases.

The Node `0.14.0` implementation has capability parity with that reference. Its
relational runtime, correctness boundaries, administration, diagnostics,
operator dashboard, realtime projections, browser behavior, and supported
adapters have native equivalents. Transport- and framework-neutral JavaScript
APIs replace the Rails-specific render surfaces. Three rows below are explicit
scope boundaries that the Ruby reference shares: the partial guard row, the
backpressure row, and the shared planned result-lookup row. They are not missing
Ruby capabilities.

`0.14.0` also adds `runtime.enqueueInternalMessage()`,
`runtime.enqueueInternalMessageInTransaction()`, and
`runtime.snapshotWithIncarnation()`. These are Node-only integration points
for a host package (such as a future commercial scaling layer), not ported
Ruby capabilities. Ruby's equivalent primitives
(`SolidObjects::Mailbox#enqueue`, `ActorSnapshot`) are already reachable
in-process, and they need no dedicated public API. Node's `exports` map enforces
a package-privacy boundary between a package and its dependents. Ruby has no
such boundary between a gem and its dependents.

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

| Capability                                                                                                    | Status  | TypeScript shape or remaining work                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor registry, durable identity, JSON state, and adjacent state migrations                                   | Native  | Ordinary classes, static actor types, inferred state, explicit migrations, and isolated runtime context across every actor-instance callback.                                                                                                                                                                                          |
| Fluent committed calls and background delivery                                                                | Native  | `await reference.operation()` and `reference.send.operation()`.                                                                                                                                                                                                                                                                        |
| Ordered mailbox, sequence allocation, idempotency, retries, dead letters, leases, renewal, and fenced commits | Native  | Relational ready/claimed membership tables, distinct generated request IDs and caller idempotency keys, durable history, and adapter-appropriate sequence locking.                                                                                                                                                                     |
| Domain rejection and strict poison ordering                                                                   | Native  | Rejections accept JavaScript identifier-style codes and roll back without retry; invalid codes fail terminally, while retryable failures block later operations until completion or dead-lettering.                                                                                                                                    |
| Bounded activation passes and hot-actor fairness                                                              | Native  | Configurable turn-count and elapsed-time budgets bound each pass, then move only that actor's already-due memberships behind actors already waiting.                                                                                                                                                                                   |
| Bounded claim candidate scan                                                                                  | Native  | A configurable ordered scan continues to another ready actor when a worker loses the first candidate's lease race.                                                                                                                                                                                                                     |
| Backpressure and payload caps                                                                                 | Partial | Serialization enforces a shared maximum JSON nesting depth, raising `InvalidPayload`, and an optional caller-supplied `maxBytes` limit, raising `PayloadTooLarge`; reminder names are bounded to 255 characters. Distributed per-actor rate limits and global admission control do not exist yet, matching the open Ruby roadmap item. |
| Idle activation cache                                                                                         | Native  | Long-running workers retain hydrated actors under renewable fenced leases, restore public state after failed turns, and release on timeout, fairness yield, lease loss, or shutdown.                                                                                                                                                   |
| Transactional effects and outcome operations                                                                  | Native  | At-least-once handlers receive immutable stable effect, attempt, source-message, and actor identity; success and failure operations also receive the originally staged arguments for correlation.                                                                                                                                      |
| Actor-to-actor delivery                                                                                       | Native  | `sendTo(reference).operation()` stages delivery in the source actor commit.                                                                                                                                                                                                                                                            |
| One-shot and recurring reminders                                                                              | Native  | Scheduling, replacement events, catch-up policy, stale-claim recovery, pausing, authorized inspection, and idempotent resume are implemented.                                                                                                                                                                                          |
| Same-database commit actions                                                                                  | Native  | Registered actions receive source-message identity, mailbox sequence, activation generation, and the fenced transaction connection.                                                                                                                                                                                                    |
| Ambient transaction rejection                                                                                 | Native  | Committed calls and message waits fail before blocking when the current async context already owns a transaction on the Solid Objects adapter.                                                                                                                                                                                         |
| Direct application-write isolation during actor code                                                          | Partial | `guardApplicationDatabase()` fails closed for operations, projections, migrations, and commit actions; only the supplied fenced commit-action connection may write. Unwrapped clients cannot be intercepted.                                                                                                                           |
| Committed snapshots                                                                                           | Native  | `snapshot()` returns authorized persisted fields and inferred getters from one read-only committed state image; realtime replay reads explicit observables without mailbox history.                                                                                                                                                    |
| Actor destruction and incarnation fencing                                                                     | Native  | Authorized cascading deletion creates a fresh instance ID on recreation; an authorized waiter receives `ActorDestroyed` when that incarnation disappears.                                                                                                                                                                              |
| Result recovery and sync timeout diagnostics                                                                  | Native  | Status, result, and wait reauthorize the stored operation; terminal failure raises structured `MessageFailed`; whole-call adapter deadlines distinguish enqueue, wait, database, activation, and mailbox blockers.                                                                                                                     |
| Result lookup by request ID                                                                                   | Planned | This is also an open Ruby roadmap item and will be implemented in both runtimes when its authorization shape is settled.                                                                                                                                                                                                               |

## Operations

| Capability                                                                    | Status | TypeScript shape or remaining work                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process registration, heartbeats, stale claim recovery, and graceful shutdown | Native | Runtime roles persist host, PID, runtime versions, draining and stopped transitions, cooperative cancellation, and a bounded shutdown deadline; cleanup recovers stale claims.                                                                                                                                                                                                                  |
| Failed-role replacement                                                       | Native | Built-in and registered roles are rebuilt through their factories with capped backoff; shutdown is the terminal replacement boundary.                                                                                                                                                                                                                                                           |
| Additional supervised components                                              | Native | `registerComponent()` builds, validates, runs, and stops application components with the runtime.                                                                                                                                                                                                                                                                                               |
| Dead-letter inspection and retry                                              | Native | `runtime.deadLetters` provides deny-by-default immutable inspection and idempotent durable retry linkage.                                                                                                                                                                                                                                                                                       |
| Reconciliation reads                                                          | Native | Authorized cursor pages cover active, quiet, and orphaned instances; bounded state batches are migrated and deeply frozen.                                                                                                                                                                                                                                                                      |
| Message, process, and opt-in instance retention                               | Native | Supervised scheduling bounds message and process growth; authorized manual APIs add preview and keep destructive instance expiration explicit.                                                                                                                                                                                                                                                  |
| Doctor and schema verification                                                | Native | Structured checks cover configuration, schema/version shape, adapter server versions, neutral-context policy probes, live roles, and a targeted round trip.                                                                                                                                                                                                                                     |
| CLI                                                                           | Native | The packaged executable loads an application runtime and exposes start, diagnostics, processes, dead letters, reminders, and explicit retention pruning as JSON.                                                                                                                                                                                                                                |
| Operator dashboard                                                            | Native | The opt-in `solid-objects/web` export provides Fetch and Node/Connect mounting, authorized runtime views and actions, session-backed CSRF, filtering, paging, charts, and immutable extension hooks. Matches the Ruby dashboard's own documented limits: no audit trail of admin actions, dead-letter retry is one at a time, and pause sets a flag rather than interrupting an in-flight turn. |
| Structured instrumentation                                                    | Native | An isolated transport-neutral sink emits immutable lifecycle metadata and structurally excludes application payloads.                                                                                                                                                                                                                                                                           |
| Public test helper                                                            | Native | `runtime.testing` provides role-selective deterministic draining, explicit-time due-reminder execution, and dependency-ordered reset without relying on cascades.                                                                                                                                                                                                                               |

## Databases and wake-up

| Capability               | Status | TypeScript shape or remaining work                                                                                                                                                                                                                                                    |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite                   | Native | Uses built-in `node:sqlite`, serialized process-local access, bounded transient writer retries, foreign keys, strict tables, database time, and deadline-bounded access and lock waits.                                                                                               |
| PostgreSQL               | Native | Optional `pg` 8.23 peer, bounded pooling, 64-bit schema, row-locked sequences, server checks, and deadline-bounded pool, statement, and lock waits.                                                                                                                                   |
| MySQL                    | Native | Optional `mysql2` 3.23 peer, bounded pooling, InnoDB schema, row-locked sequences, scoped deadlock retry, and deadline-bounded pool, query, and lock waits. Ruby also tests a second client, `trilogy`; Node has no comparable second MySQL client, so only `mysql2` is tracked here. |
| Durable polling fallback | Native | Every role progresses without a notification service.                                                                                                                                                                                                                                 |
| In-process wake-up       | Native | A generation-based default adapter prevents claim-to-wait signal loss; commits wake role-specific waiters and polling remains the fallback.                                                                                                                                           |
| PostgreSQL wake-up       | Native | `database.wakeUp()` uses one dedicated event-driven client, role-specific `LISTEN/NOTIFY`, generation fencing, reconnectable listeners, and durable polling fallback.                                                                                                                 |
| Redis wake-up            | Native | An optional `redis` peer provides role-specific Pub/Sub over separate lazy publisher/subscriber connections, with bounded failures and durable polling fallback.                                                                                                                      |

Every wake-up adapter above is opt-in. Neither runtime selects one
automatically. An application that configures nothing keeps polling. Each
runtime warns once when live processes share a database without a configured
cross-process adapter. This limit is intentional in both runtimes. It is not a
gap between them.

## Realtime and browser behavior

| Capability                                                   | Status         | TypeScript shape or remaining work                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit observable projection and durable invalidations     | Native         | `observables()` is opt-in and invalidation-only by default. `broadcastValue()` sends changed values; `broadcastInvalidation()` explicitly sends only changed names while comparing the real value. Private or subscriber-specific values belong behind invalidation-only component endpoints or in typed payloads. |
| Action Cable channels and signed stream names                | Not applicable | `runtime.realtime` provides authenticated transport-neutral sessions; the host owns its HTTP/WebSocket server and authentication.                                                                                                                                                                                  |
| Authorized subscriptions                                     | Native         | Each request is denied by default and authorized before actor lookup; sessions replay committed observables and fence ordered durable revisions. Multi-process hosts explicitly bridge their shared transport.                                                                                                     |
| Turbo scalar replacement                                     | Not applicable | The browser client exposes invalidations to application rendering code. Framework adapters can be separate packages.                                                                                                                                                                                               |
| Keyed component refresh, morph/replace, and batch coalescing | Native         | A typed framework-neutral registry selects explicit dependencies, coalesces batch requests, aborts superseded work, fences each target, and delegates synchronous application strategy to the host.                                                                                                                |
| Personalized payload broadcasts                              | Native         | Static typed projections run against committed state under each fresh subscriber context, reauthorize as queries, isolate failures, and carry independent revision fences.                                                                                                                                         |
| Real-browser compatibility suite                             | Native         | Playwright exercises subscription replay over native WebSocket, incarnation/revision fences, payload delivery, component batching, and cancellation in Chromium.                                                                                                                                                   |

## JavaScript-only: the browser runtime

`0.14.0` ships an in-browser runtime with SQLite WASM storage
([#17](https://github.com/cardmagic/solid-objects-js/issues/17)). The
runtime itself is a JavaScript-only capability: the Ruby gem has no browser
target, so no Ruby parity row exists for milestones M1 through M3. The
transmit family (milestone M4) started here but is not JavaScript-only; the
next section tracks it as a shared capability. All four milestones are
complete:

- M1: the shared modules no longer import Node built-in modules, a
  registered platform factory supplies async context propagation, and
  `pnpm run check` enforces a Node-free import graph for the browser-safe
  modules.
- M2: `solid-objects/database/sqlite-wasm` implements the `Database`
  contract on SQLite WASM. The full runtime passes a round-trip test
  against it, and Playwright proves OPFS persistence across a page reload.
- M3: `solid-objects/browser/host` hosts the full runtime in a browser
  module worker on OPFS storage, with durable actor state across page
  reloads proven in Chromium. `solid-objects/browser/tab-host` elects one
  leader per origin with the Web Locks API and serves every tab over a
  `BroadcastChannel`; Playwright proves shared state across two tabs and
  failover with durable continuation after the leader tab closes.
  `solid-objects/database/shared-sqlite-wasm` goes further: it moves the
  election behind the `Database` seam, so every tab runs the ordinary
  `configure -> install -> ref` flow and the runtime's own leases and
  fencing arbitrate the tabs' workers. The plan
  named a `SharedWorker` as the host; Web Locks election between dedicated
  workers replaced it, because OPFS sync access handles exist only in
  dedicated workers.
- M4: `solid-objects/transmit` drains the local effects outbox to a
  server runtime with at-least-once delivery, per-actor order, and an
  idempotent server ingest. Vitest proves order under transmit failures,
  replay deduplication, and recovery after an offline period, on SQLite,
  PostgreSQL, and MySQL.

## JavaScript-only: live signals

`reference.live` (the `solid-objects/signals` entry) adapts committed
actor state to the proposed standard JavaScript signals API, so
signal-consuming renderers track actors with no manual registration. No
Ruby row exists because the slot it fills is already native in Rails:
the gem's Turbo and Action Cable component surface re-renders partials
from the same committed observables. Each runtime renders with its
ecosystem's primitive; the guarantee — views track committed state under
revision fencing and the same privacy model — is what parity preserves.

## Shared capability: the transmit family

The transmit family is the one part of the browser work that both runtimes
share. The Ruby gem ships it in `0.14.0`
([solid-objects-ruby#49](https://github.com/cardmagic/solid-objects-ruby/pull/49),
from proposals [#47](https://github.com/cardmagic/solid-objects-ruby/issues/47)
and [#48](https://github.com/cardmagic/solid-objects-ruby/issues/48)):
`SolidObjects::Transmission.receive` is the ingest, and `Actor#transmit`
with `register_transmit` is the staging side. Identifiers differ by
runtime idiom; the wire contract is what both sides guarantee:

- envelope keys are camelCase (`effectId`, `actorType`, `actorId`,
  `operation`, and an optional `arguments` that defaults to an empty
  object);
- the ingest idempotency key is `transmit:<effectId>`, byte for byte;
- a replay with changed arguments raises the idempotency conflict on both
  sides and leaves the first application intact.

`compatibility/transmit-envelopes.json` is committed to both repositories
with a consuming test on each side, so the contract is enforced from both
sides of the repository boundary. Manual cross-runtime QA (Node to Rails
and Rails to Node) ran in solid-objects-ruby#49; the one disagreement it
found (the optional `arguments` default) is fixed and pinned by the shared
fixture.

## Rails-specific surfaces

Rails generators, Active Record models/controllers, Turbo rendering, and
Action Cable are not copied into this package. The Rack dashboard is represented
by the framework-neutral Fetch and Node adapter, renderer callbacks, and the
same authorization and CSRF boundaries.

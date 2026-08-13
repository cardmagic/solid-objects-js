# Changelog

## Unreleased

- Persist the start of graceful runtime-role shutdown and expose its timestamp
  so operators can distinguish actively draining processes from dead owners.
- Release actor, message, effect, reminder, and broadcast ownership atomically
  during graceful shutdown and recover stale draining processes as well.
- Persist hostname, host PID, Node version, and Solid Objects version for every
  runtime role and expose them through immutable process administration reads.
- Make typed snapshots return persisted fields and getter values from one
  committed state image, rejecting getters that mutate state or stage work.
- Probe configured authorization policies with a neutral context in the doctor
  and warn when sensitive access is open or a policy cannot evaluate safely.
- Align effect and commit-action context with their durable source message and
  activation fence, using immutable TypeScript contracts.
- Bound runtime shutdown with a configurable deadline and report components
  that do not cooperate with cancellation or stop before it expires.
- Separate generated request identity from caller-supplied idempotency keys and
  expose both with enqueue time through immutable actor message context.
- Preserve isolated runtime ownership across operation, lifecycle, observable,
  and payload callbacks while keeping lifecycle callbacks message-free.
- Retry transient SQLite writer acquisition with bounded capped backoff without
  replaying transaction callbacks or extending synchronous deadlines.
- Expose concise `configure()` and isolated `createRuntime()` entry points;
  isolated actor turns resolve references from their executing runtime.
- Raise structured `MessageFailed` errors for terminal operations and
  `ActorDestroyed` when an authorized incarnation disappears during a wait.
- Add deny-by-default dead-letter inspection and idempotent durable retry.
- Add sequential schema migrations and upgrade version-one SQLite databases.
- Add bounded, authorization-gated reconciliation reads for actor lifecycle
  repair.
- Add previewable bounded retention for messages, stopped processes, and
  opt-in actor instances.
- Add structured installation diagnostics and a targeted durable round trip.
- Add deterministic runtime draining and explicit database reset helpers for
  tests.
- Add isolated structured lifecycle instrumentation with metadata-only events.
- Add reminder replacement events and authorized inspection and resume APIs.
- Add deny-by-default transport-neutral realtime subscriptions with committed
  replay and revision fencing.
- Add injectable generation-based wake-up signals with a process-local default.
- Add supervised role replacement through original factories with capped
  restart backoff.
- Add authorized process inspection and atomic stale-owner cleanup.
- Add a JSON CLI for runtime startup, diagnostics, administration, and explicit
  retention pruning.
- Add bounded multi-turn activation passes with database-ordered hot-actor
  fairness.
- Add an opt-in application-database facade that rejects direct writes during
  actor execution while keeping registered commit actions writable.
- Add typed subscriber-specific realtime payloads with query authorization,
  committed-state projection, failure isolation, and independent revision
  fencing.
- Add PostgreSQL 14+ through the optional `pg` driver with pooled transactions,
  row-locked sequence allocation, portable schema and set queries, diagnostics,
  and real-server integration coverage.
- Add opt-in role-specific PostgreSQL wake-ups with one event-driven listener
  per runtime and polling as the correctness fallback.
- Add a typed browser component registry with keyed dependencies, replace/morph
  strategies, batch coalescing, cancellation, and per-target revision fencing.
- Add Chromium QA for native WebSocket subscription replay, realtime fences,
  personalized payloads, component batching, and request cancellation.
- Add optional Redis Pub/Sub wake-ups with role-specific channels, separate
  lazy connections, bounded failure handling, and real-server integration QA.
- Add MySQL 8.0+ through the optional `mysql2` driver with pooled transactions,
  an InnoDB schema, scoped enqueue deadlock recovery, diagnostics, and
  real-server coverage across MySQL 8.0 and 8.4.
- Add hydrated idle activation reuse with renewable fenced leases, protected
  async lifecycle hooks, state restoration after failed turns, and release on
  timeout, fairness yield, lease loss, and shutdown.
- Bound activation passes by configurable elapsed time as well as message
  count so slow hot actors yield workers fairly.
- Add independent supervised schedulers for expired message and process
  retention and stale process recovery, with disable switches and bounded
  failure backoff.
- Bound synchronous database pool, query, and lock waits across SQLite,
  PostgreSQL, and MySQL; distinguish an uncommitted enqueue timeout from a
  recoverable durable wait timeout; and report structured database, activation,
  and mailbox blockers.
- Reject committed calls and message waits inside an ambient Solid Objects
  database transaction before they can self-deadlock.
- Scan a bounded set of ready actor candidates so a lost lease race does not
  make a worker report idle while other actors are ready.

## 0.1.0 - 2026-08-13

- Add ordinary TypeScript actor classes with inferred, typed references.
- Add committed calls, asynchronous sends, actor-to-actor delivery, reminders,
  effects, commit actions, snapshots, destruction, and explicit observables.
- Add a SQLite durable mailbox with ordered turns, idempotency, retries, leases,
  fencing, dead letters, process heartbeats, and stale-claim recovery.
- Add supervised workers for actor turns, effects, reminders, and broadcasts.
- Add a Node-free browser client for versioned observable invalidations.
- Deny public actor operations and destruction by default, and reauthorize
  durable message status, result, and wait reads.
- Use options objects for library APIs with more than two inputs and enforce the
  convention during type checking.
- Name invoked actor methods `operation` throughout the API and persistence,
  and name message submission semantics `delivery_mode`.
- Publish SQLite as the only database adapter supported by the initial release.

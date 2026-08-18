# Changelog

## Unreleased

- Make the failure-recovery demo's serialization proof count messages rather
  than executions. A worker that loses its lease mid-operation leaves the
  replacement to execute the same message again, which is the at-least-once
  contract, so the proof failed on slower machines for behaviour it documents
  elsewhere. Each serialization event now carries its attempt and process, so a
  start pairs with its own finish instead of with whichever finish came next.
  The proof asserts that every start has its own finish, that exactly the two
  sent messages ran, and that the surviving attempt of each message never
  overlaps another message's surviving attempt; a superseded attempt may
  overlap anything, because it keeps running until it notices the lost lease and
  its write is fenced out. The committed state check is unchanged, and the demo
  reports the executions it saw. `assertSerializedExecution` moved into its own
  module with unit coverage for the clean, retried, superseded-overlap,
  still-running-replacement, unexplained-overlap, boundary, unfinished,
  unmatched-finish, double-start, restart-after-finish, and lost-message cases.

## 0.13.2 - 2026-08-17

- Accept a `key` on `schedule`, naming a reminder for the item it is waiting
  on rather than for its operation, so one actor can hold an alarm per queued
  item. Scheduling the same key again moves that item's alarm and leaves the
  others alone. Without a key the name is still the operation, so existing
  reminders keep their names and their coalescing behaviour. Adds a nullable
  `message_operation` column to the reminders table, left null on existing rows.
  The composed name is bounded by the 255 characters MySQL holds it in, checked
  on the name rather than the key alone.
- Add an authorized `runtime.administration.processes()` query for inspecting
  live and stale process rows through the runtime's database adapter.
- Document rolling-deployment overlap as a reason for the polling-only warning.

## 0.13.1 - 2026-08-16

- Back idle actor, effect, reminder, and broadcast polling off exponentially
  from the configured fast interval to a new one-second idle ceiling. Any
  processed work or wake-up resets the role immediately, and actor polling
  remains capped by the lease-renewal interval.
- Expose each role's current polling interval and emit
  `solid_objects.polling.interval_changed` instrumentation for every idle,
  work, and wake-up transition.
- Warn once when live processes share the database without a configured
  cross-process wake-up adapter.
- Preserve older custom wake-up adapters that return `void`; return `true` for
  notifications and `false` for timeouts from the built-in PostgreSQL, Redis,
  and in-process adapters so adaptive polling can distinguish them.
- Add a reproducible four-role SQLite idle benchmark.
- **Behavior change:** `pollingIntervalMilliseconds` is now the fast interval
  after activity, not a constant idle cadence. Existing explicit values back
  off to `idlePollingIntervalMilliseconds`, which defaults to `1_000`. Set
  both options to the same value to preserve a fixed cadence.

## 0.13.0 - 2026-08-16

- Replace the exhaustive README with an outcome-first introduction, explicit
  fit and correctness boundaries, sourced comparisons, and factual design
  provenance.
- Add a packaged SQLite quickstart, a clean-install tarball smoke test, and a
  deterministic multi-process crash and fencing demonstration.
- Add a reproducible benchmark harness, record locally observed SQLite,
  PostgreSQL 18, and MySQL 8.4 measurements, and label other configurations as
  unmeasured.
- Add support, contribution, and security policies plus stronger local
  Markdown link validation.
- **Breaking:** make unwrapped observables invalidation-only by default. They
  continue to detect changes and refresh dependent components without storing
  or sending their values. Wrap a projection in `broadcastValue()` to share
  its scalar value with every authorized actor subscriber.

- Add `broadcastInvalidation()` so actors can drive granular component refresh
  without persisting or sending the observable value.
- Add `broadcastValue()` for the explicit value-bearing observable contract.
- Extend durable and browser invalidation envelopes with invalidation-only
  observable names.
- Add the framework-neutral `solid-objects/web` operator dashboard with Fetch
  and Node/Connect mounting, runtime statistics, instance and mailbox detail,
  reminder/effect/broadcast/dead-letter/process views, filtering, paging,
  instance pause/resume, and idempotent dead-letter retry.
- Deny dashboard data by default through route-specific administration policy,
  require session-backed masked CSRF tokens for actions, escape stored values,
  and serve a strict content security policy.
- Add immutable dashboard extension routes, tabs, renderer overrides, and
  middleware, plus configurable Chart.js dashboards and live statistics.
- Preserve downstream request bodies when the Node/Connect dashboard adapter
  cascades a request outside its mount path.
- Add authorized and public read-only dashboard access modes that omit mutation
  controls, reject POST actions, and require no CSRF session for public demos.
- Refocus the README and package metadata on native Node.js concurrency,
  realtime state synchronization, and database-backed infrastructure.

## 0.12.1 - 2026-08-13

- Accept camelCase rejection codes and fail malformed codes immediately with
  non-retryable `InvalidRejectionCode` diagnostics.
- **Breaking:** include the originally staged `arguments` in effect success and
  failure callback payloads so actors can correlate concurrent effects.
- Add `runtime.testing.runDueReminders({ now })` for deterministic reminder
  tests without database writes or sleeps.
- Document adapter value mapping, readonly snapshot helpers, payload type-alias
  requirements, realtime observable exposure, message-reference authorization,
  durable `void` results, retry backoff in tests, and administration result
  fields.

## 0.12.0 - 2026-08-13

- Document the complete public API, runtime and adapter configuration,
  state-evolution lifecycle, and error-recovery contracts.
- Complete the Ruby 0.12.0 spiritual-parity pass with Node-native runtime,
  administration, realtime, browser, and multi-adapter equivalents.
- Return claimed messages to ready membership without consuming an attempt when
  actor hydration, state migration, or activation fails before execution begins.
- Keep guarded application databases read-only during commit actions so the
  supplied fenced transaction connection is the only atomic write path.
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
- Support SQLite, PostgreSQL, and MySQL database adapters in the initial
  release.

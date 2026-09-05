# Changelog

## 0.14.7 - 2026-09-05

- Read SQL message results and completion status in one statement so concurrent
  completion cannot return a stale `null` result.
- Add `solid-objects/core` and the Cloudflare Durable Objects runtime backend.
  Each actor identity owns SQLite state, a durable mailbox, retry state,
  reminders, and effect/message outboxes. Request IDs recover ambiguous RPC
  acceptance; incarnation and execution generations fence stale commits.
- Add hibernating session Durable Objects for existing browser subscriptions,
  including multi-actor connections, fresh authorization, personalized payloads,
  revision fencing, and durable subscription cleanup.
- Share actor turn evaluation across SQL and Cloudflare. Keep Workers types and
  imports separate from the Node target. Add Workers integration tests, a
  runnable example, bundle checks, and an explicit backend capability matrix.
  The Cloudflare backend is experimental pending deployed failover/soak testing.

## 0.14.6 - 2026-09-03

- Poll effects, reminders, and broadcasts through ordered indexes installed by
  schema migration 8. PostgreSQL and MySQL claim one row with
  `FOR UPDATE SKIP LOCKED`; candidate probes avoid joins and load actor identity
  by primary key after the claim. SQLite keeps its serialized transaction path.
  The broadcast revision guard has its own
  `(instance_id, state_revision, status)` index instead of rescanning the outbox
  for every candidate. Claim transactions use read committed isolation on
  PostgreSQL and MySQL so preceding recovery work cannot turn row skipping into
  InnoDB gap-lock contention.
- Replace bulk broadcast and reminder recovery updates with separate available
  and stale probes. Compare category heads without locking them, lock only the
  oldest candidate by primary key, and retry past work already locked by another
  claimant. This preserves global delivery order, concurrent progress,
  per-instance broadcast revision order, stale-process recovery, and
  at-least-once delivery.
- On 50,000 production-shaped rows, SQLite, PostgreSQL 18, and MySQL 8.4 all
  move from scans and explicit sorts to ordered index probes. The worst SQLite
  broadcast probe fell from 944 ms to 0.018 ms; PostgreSQL's probes finish in
  0.02-0.09 ms and MySQL's in 0.10-1.2 ms.

## 0.14.5 - 2026-08-29

- Record the Ruby state warning in the parity ledger. The row said the Ruby gem
  has no soft threshold. It carries the same `solid_objects.state.large` event
  and the same 5 MB hard default from `0.14.3`, as `warn_state_bytes`. Its
  threshold defaults to 64 KB rather than 128 KB, because the measured Ruby
  curve falls sooner: the gem keeps 55% of its empty-state throughput at 13 KB
  of state, where this package keeps 98% at 16 KB. Documentation only; no
  runtime change.

## 0.14.4 - 2026-08-29

- Cut the per-turn state traversals from eight to four. The runtime built the
  whole state image eight times for each committed operation, and nine times
  for a query, where two are necessary. The commit path now passes the image it
  already holds to the observables guard, and the query check reads the
  committed image instead of taking its own. The guard is unchanged: it still
  reads the state after `observables()` returns, because only that read sees a
  mutation.
- Compute the default state once for each registered actor class. Every `send`
  and every hydration constructed a throwaway actor and serialized its full
  default state. The constructor must not depend on external state, so one
  cached image per validated definition is correct. Each caller receives a
  detached copy.
- Stop building a string that `normalizeJson` discards. It called
  `JSON.stringify` on every value, then used the result only when a byte limit
  was given. `actorState`, `deepCopy`, and `stableJson` all pass no limit.
- Measured on an Apple M5 with SQLite: 1.2x throughput at 0 KB of state, 1.3x
  at 16 KB, 1.6x at 128 KB, and 2.1x at 1 MB. See
  [Large state](docs/benchmarks.md#large-state).
- Add `warnStateBytes`, a soft threshold that defaults to 128 KB. A commit
  above it reports one `solid_objects.state.large` instrumentation event with
  the actor type, the actor ID, the byte count, and the threshold. The runtime
  reports it only after the commit succeeds, so a turn that rolls back stays
  silent. The event holds no application state, and the runtime measures the
  size only when an `instrumentation` callback is configured. `maxStateBytes` keeps its 5 MB hard
  default, which fails the turn. Throughput at that size is about one operation
  per second, so the warning names the constraint before an application meets
  it.
- Add a `large-state` benchmark scenario, `pnpm run benchmark:large-state`,
  that reports operations per second at 0 KB, 16 KB, 128 KB, and 1 MB, and
  document the measured curve in `docs/state-and-lifecycle.md`.

- Align the use-case claims with the Ruby gem. The README table sold per-key
  rate limits, while the Ruby fit guide called a rate limiter an anti-pattern.
  Both projects now draw one line: a low-rate quota that a reminder refills
  fits, because each check is one durable ordered message, and a limiter that
  every request touches does not.
- Point the high-QPS reader at [Solid Objects Pro](https://solidobjects.pro/)
  from the rate-limit sentence in the README and `docs/fit.md`, and name what
  it adds for that shape: grouped commits and ephemeral operations. The README
  states that it ships for the Rails gem today and that the Node build is in
  development.
- Move the early-release caveat off the first screen. It is now a `Status`
  section at the end of the README, with a table-of-contents entry, which
  matches where the Ruby gem keeps the same statement. The first screen keeps
  the transaction caveat, because that one changes whether a reader should
  install anything.
- State the workflow limit next to the workflow row instead of only in
  `docs/fit.md`. A workflow fits when one entity owns the mutable state and its
  mailbox holds the step order. A durable execution engine that replays named
  steps from a step log is a different tool.

## 0.14.3 - 2026-08-25

- Rewrite the first screen around the objection a reader actually has. The
  README led with a shopping cart that appended to an array, which invites the
  reply that one SQL statement already does it. It now leads with the ticket
  sale from the homepage: 100 seats, a hold, a ten-minute expiry that frees the
  seat, and a published count. That is the smallest example needing three
  things from one number, and the three things are the argument.
- Answer "why not just use transactions?" in the first screen instead of
  burying the fit sections. The section concedes the transaction and the row
  lock first, including `navigator.locks` in the browser, then argues scope
  rather than discipline: any `expiresAt` or `scheduledAt` column is evidence
  the critical section already outlived the lock, and what follows it is a
  sweeper and a race.
- Add "Is it worth installing here?", which names who should not install this,
  and point readers with high-QPS reads or hot identities at
  [Solid Objects Pro](https://solidobjects.pro/).
- Correct two claims. The realtime section said a value is published once per
  change from the saving turn; the turn records the publication atomically,
  while delivery is a separate worker and is at least once. Design provenance
  said the API was redesigned around Web Components; there is no
  `customElements` or `HTMLElement` in the package.
- Cut the README from 590 to about 540 lines by removing what `docs/` already
  documented and what the page said three times, and add the table of contents
  the standard-readme specification asks for above 100 lines.

## 0.14.2 - 2026-08-24

- State that background pickup needs `runtime.run(signal)`
  ([#22](https://github.com/cardmagic/solid-objects-js/issues/22)). The
  README's programming-model example works without it because the caller's
  own path executes the call, and nothing on that page said that a process
  which installs and then waits claims nothing. An external prober built a
  two-process harness from the README and read the unclaimed messages as
  stranded. The README and `docs/operations.md` now state it, and
  `test/background-pickup.test.ts` pins it: a sent message reads `ready`
  after `install()`, and `completed` once `run(signal)` starts the roles.
- Build the same example with `configure()` and address the actor as
  `Cart.ref("cart-123")`, matching every other reference example in the
  documentation. `createRuntime()` deliberately leaves the process default
  unset, so the static form needs `configure()`.
- Add `examples/at-least-once` and `pnpm run test:at-least-once`
  ([#23](https://github.com/cardmagic/solid-objects-js/issues/23)): an
  executable proof that the at-least-once clause fires and that the
  documented remedy absorbs it. An effect worker crashes between the
  external sink write and the acknowledgement; after restart the sink
  reads 2 with deduplication off, and 1 when a guard on the stable
  effect id is in place. The state commit happens exactly once in both
  runs, and both deliveries carry the same effect id. CI runs the demo
  alongside the recovery demo.

## 0.14.1 - 2026-08-23

- Add `solid-objects/signals`, live signals on actor references
  ([#24](https://github.com/cardmagic/solid-objects-js/issues/24)). One
  side-effect import enables `reference.live`: read-only signals on the
  proposed standard JavaScript signals API (`signal-polyfill`, a new
  optional peer dependency) that subscribe through an in-process
  `runtime.realtime` session when first watched and unsubscribe after a
  linger when the last watcher leaves. Value-broadcast observables feed
  named signals; `live.snapshot` re-fetches the authorized snapshot on
  each accepted envelope; `live.payloads.<name>` carries personalized
  payload projections under their independent revision fences; stale
  revisions are fenced. Works in Node and
  in the browser runtime.

## 0.14.0 - 2026-08-23

- Add `solid-objects/database/shared-sqlite-wasm`, the transparent
  multi-tab database. Every tab runs an ordinary
  `configure -> install -> ref` flow against the same shared database; the
  adapter elects one holder per origin with the Web Locks API, sends every
  other tab's SQL over a `BroadcastChannel` session to the holder, and
  fails over onto the same OPFS state when the holder's tab dies. The
  runtime's leases and fencing arbitrate the tabs' workers exactly as they
  arbitrate Node processes. A Playwright test proves plain actor references
  incrementing one durable counter from two tabs with failover.
- Add `solid-objects/browser/tab-host`, the multi-tab host that completes
  milestone M3 of the in-browser runtime plan
  ([#17](https://github.com/cardmagic/solid-objects-js/issues/17)). Every
  tab starts a candidate host; the Web Locks API elects one leader per
  origin, and only the leader opens the database and runs the runtime.
  Tabs invoke actors through a `BroadcastChannel` client that retries with
  idempotent request ids. When the leader's tab dies, the lock releases,
  the next host promotes, and the runtime continues from the same OPFS
  state. A Playwright test proves shared state across two tabs and
  failover after the leader closes.
- Share the transmit wire contract with the Ruby gem. The golden fixture
  file `compatibility/transmit-envelopes.json` is committed to both
  repositories with a consuming test on each side; `receiveTransmitEnvelope`
  now defaults a missing `arguments` to an empty object, matching the Ruby
  ingest and the staging side.
- Add `solid-objects/transmit`, milestone M4 of the plan. An actor
  stages a transmit intent with `this.transmit().operation(arguments)` (or with
  `emit(TRANSMIT_EFFECT, ...)` for a different target) in the same
  transaction as its state change. `registerTransmit` drains the outbox
  with at-least-once delivery and per-actor order (an ordered drain up to
  the claimed effect's mailbox sequence), and `receiveTransmitEnvelope` gives
  the server an idempotent ingest keyed on the effect id. Vitest covers
  order under transmit failures, replay deduplication, and recovery after
  an offline period; a Playwright test drains a browser outbox into the
  Node server runtime.
- Change `TurnContextStore` to synchronous scoping. The store no longer
  stays set across `await` boundaries, so an open transaction scope cannot
  leak into interleaved tasks and trip the inside-transaction guards. In
  the browser those guards are best-effort; Node keeps full
  `AsyncLocalStorage` semantics.
- Retry OPFS SAH pool acquisition. The upstream module caches a failed
  initialization; the adapter now passes `forceReinitIfPreviouslyFailed`,
  so a new leader can claim the pool after the old tab dies.

- Add a platform seam for async context propagation
  (`src/platform/context-store.ts`). Shared modules no longer import
  `node:async_hooks` directly. Node entry points register an
  `AsyncLocalStorage` factory. A `TurnContextStore` gives a browser host a
  turn-scoped store for serialized actor turns. This is milestone M1 of the
  in-browser runtime plan
  ([#17](https://github.com/cardmagic/solid-objects-js/issues/17)).
- Route UUID generation through `src/platform/uuid.ts`, which uses the
  standard `crypto.randomUUID()`. Shared modules no longer import
  `node:crypto`.
- Add `check:browser-imports` to `pnpm run check`. The script walks the
  import graph of the browser-safe modules and fails when a `node:` module
  or a server-only driver reaches that graph.
- Add `solid-objects/browser/host`, the entry point for a runtime host
  inside a browser worker. An import registers the browser platform: a
  turn-scoped context store and a browser host identity. The module
  re-exports the core runtime API and the WASM adapter. A Playwright test
  runs the full runtime in a Chromium module worker and proves durable
  actor state across a page reload. This is the first stage of milestone M3
  ([#17](https://github.com/cardmagic/solid-objects-js/issues/17)).
- Replace the `Buffer.byteLength` payload size check with `TextEncoder`, so
  serialization works without the Node `Buffer` global.
- Route the process identity (hostname, process id, runtime version)
  through `src/platform/host-identity.ts`. The repository no longer imports
  `node:os` or reads `process.pid` directly.
- Add `solid-objects/database/sqlite-wasm`, a browser-safe `Database`
  adapter on `@sqlite.org/sqlite-wasm` (an optional peer dependency). The
  full runtime passes its round-trip test against this adapter in Node, and
  a Playwright test proves transactions, rollback, and OPFS persistence
  across a page reload in Chromium. This is milestone M2 of the in-browser
  runtime plan
  ([#17](https://github.com/cardmagic/solid-objects-js/issues/17)).

- Add `runtime.enqueueInternalMessage()` and
  `runtime.enqueueInternalMessageInTransaction(connection, options)`, public
  entry points for a host package to enqueue an `internal`-delivery-mode
  actor message without going through user authorization. The
  transaction-scoped variant accepts a caller-supplied `DatabaseConnection`
  so the enqueue can commit atomically alongside other writes in the same
  transaction; call the new `runtime.announceInternalMessage(message)` after
  that transaction commits to wake worker roles the same way a normal
  enqueue does.
- Add `runtime.snapshotWithIncarnation(reference)`, returning the same
  authorized fields as `snapshot()` alongside the read instance's
  `instanceId`, `revision`, and `createdAtMs`, computed from one shared read.
  `instanceId` is a random UUID, not a monotonically increasing value, so a
  caller that needs to detect actor recreation (a new incarnation
  superseding an old one, regardless of revision) should fence on
  `createdAtMs` rather than comparing `instanceId` values directly.
  `createdAtMs` orders incarnations at millisecond granularity; destroying
  and recreating the same actor identity within the same millisecond
  produces two incarnations a caller cannot order by `createdAtMs` alone.
  See `docs/correctness.md`.

## 0.13.3 - 2026-08-18

- Lower the supported Node.js floor from 24.15.0 to 24.4.0. Node.js 24.4.0 is
  the first release that accepts `readBigInts` on the `DatabaseSync`
  constructor, which the SQLite adapter needs to read 64-bit integers without
  losing precision. Node.js 24.0.0 through 24.3.x ignore the option, and the
  effect recovery and transaction retry tests fail there. A new CI job runs the
  default suite, the build, the packaged artifact smoke test, and the recovery
  demo on the floor.
- Record that `node:sqlite` stays experimental until Node.js 24.15.0 and prints
  a warning on stderr before it.
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

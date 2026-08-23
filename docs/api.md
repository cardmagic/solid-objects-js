# Public API reference

The package exports one server entry point plus database, wake-up, and browser
subpaths. TypeScript declaration files remain the source of truth for exact
generic signatures; this index explains the supported role of every export.

## `solid-objects`

### Runtime and actors

- `configure(options)`: create the process default `SolidObjectsRuntime`.
- `createRuntime(options)`: create an isolated runtime without changing the
  default.
- `SolidObjectsRuntime`: installation, registration, supervision, and manager
  owner. The normal lifecycle is `install()`, `run(signal)`, then `close()`.
  `snapshotWithIncarnation(reference)` returns the same authorized fields as
  `snapshot()`. It adds the read instance's `instanceId`, `revision`, and
  `createdAtMs` from that identical read. A caller can therefore fence a derived
  write, such as a downstream projection, against a stale or superseded actor
  incarnation. `createdAtMs` orders incarnations to the millisecond. See
  [Limitations and non-goals](correctness.md#limitations-and-non-goals) for
  the same-millisecond boundary.
- `Actor`: base class providing `ref()`, `actorId`, `currentMessage`,
  `observables()`, `reject()`, `emit()`, `commitAction()`, `schedule()`,
  `sendTo()`, and protected lifecycle hooks.
- `broadcastValue(value)`: mark an observable so its changed value enters the
  durable invalidation envelope.
- `broadcastInvalidation(value)`: compare the real observable value but put
  only its name in the durable envelope when it changes.
- `ObservableBroadcast`: the immutable marker type returned by either helper.
- `VERSION`: running package version.
- `ActorClass`, `ActorReference`, `ActorMessageSender`, `ActorSnapshot`,
  `ActorOperationNames`, `ActorQueryNames`, `StagedOperations`, and
  `ScheduledOperations`: inferred actor-class and fluent-dispatch types.
- `SnapshotWithIncarnation`: the `{ snapshot, instanceId, revision,
createdAtMs }` shape returned by `SolidObjectsRuntime.snapshotWithIncarnation`.
- `MessageReference`: immutable durable message identity with `id`,
  `requestId`, actor identity, `sequence`, `status()`, `result()`, and `wait()`.
- `InvocationOptions`, `AsyncInvocationOptions`, `SnapshotOptions`, and
  `DestroyOptions`: the options for authorization, idempotency, time, and
  schedule that the reference methods use.

`ActorIntents`, `EffectIntent`, `CommitActionIntent`, `ReminderIntent`,
`OutboundMessageIntent`, `ReminderOptions`, `OutboundMessageOptions`,
`PayloadBroadcasts`, and `PayloadBroadcastValue` describe actor-declared
transactional work and typed personalized projections.

`observables()` returns a flat object. Unwrapped values are invalidation-only:
their real values participate in change detection, but only their names enter
the durable envelope. Use an explicit marker when wire behavior matters:

```typescript
override observables(): Record<string, unknown> {
  return {
    version: broadcastValue(this.document.version),
    sidebar: broadcastInvalidation(this.sidebarForCurrentState()),
  }
}
```

Both values must be JSON-compatible. The runtime evaluates them after each
successful turn. An invalidation-only value takes part in change detection, but
the runtime never writes it to the broadcast outbox or the invalidation
envelope. The envelope carries its name in `invalidations`. A component registry
can then refresh a reauthorized endpoint, and the value stays private.

`MessageReference` does not retain an invocation's authorization context.
Supply `authorizationContext` to each `status()`, `result()`, and `wait()` call;
the runtime reauthorizes the persisted operation every time. Durable results
are JSON, so an operation that returns `undefined` or is declared `void`
resolves as `null`.

Declare named payload return shapes with a `type` alias rather than an
`interface`. `PayloadBroadcastValue` requires the implicit string index
signature of a JSON object, which TypeScript gives object type aliases but not
interfaces.

Snapshots return `DeepReadonly`, so application helpers should accept readonly
structure rather than cast it away. A helper that only needs a session ID can
preserve its useful result type with a generic boundary:

```typescript
function playerForSession<PlayerType extends { sessionId: string }>(options: {
  room: { readonly players: readonly PlayerType[] }
  sessionId: string | null
}): PlayerType | undefined {
  return options.room.players.find((player) => player.sessionId === options.sessionId)
}
```

### Reminders

A reminder is one alarm per actor and name. If you schedule a name that is
already armed, the runtime **moves the existing alarm**. It does not add a
second one. A reminder is therefore safe to re-arm from a handler that can run
more than once.

Without a key, that name is the operation. One actor then holds one alarm per
operation. If you arm one alarm per queued item, only the last one remains:

```typescript
// Wrong. Every entry overwrites the previous entry's alarm.
add({ entry }: { entry: Entry }): void {
  this.entries = [...this.entries, entry]
  this.schedule({ at: new Date(entry.waitUntil) }).deliver!()
}
```

Pass `key` when an actor is waiting on several things at once. The key is your
own identifier for the item and names that item's alarm, so each item gets one:

```typescript
add({ entry }: { entry: Entry }): void {
  this.entries = [...this.entries, entry]
  this.schedule({ at: new Date(entry.waitUntil), key: entry.id }).deliver!()
}
```

Scheduling the same key again moves that item's alarm and leaves the others
alone. The operation still decides which handler runs; the key only decides
which alarm is which.

A key must be non-empty, and the name it composes must fit the 255 characters
MySQL holds it in. That is checked on the composed name rather than the key
alone, so a long operation with a short key is caught too. A key may hold colons
of its own, because an actor member name cannot.

An actor that only needs to know "what is next" can still keep one alarm and
drain everything that is due when it fires. That costs one row instead of one
row per item. It also cannot strand an entry when the runtime coalesces an
occurrence. Prefer it for a large queue of interchangeable items. Prefer `key`
when one item needs an alarm that you can move on its own.

### Runtime managers

Every manager below is available as a property on `SolidObjectsRuntime`; the
class and result types are also exported for integration typing.

- `runtime.deadLetters` / `DeadLetterManager`: `all()` and idempotent `retry()`.
- `runtime.reminders` / `ReminderManager`: cursor-paginated `all()` and
  idempotent paused-alarm `resume()`.
- `runtime.processes` / `ProcessManager`: immutable role `all()` and stale-owner
  `cleanup()`.
- `runtime.administration` / `AdministrationManager`: an authorized
  `processes()` query for inspecting live and stale process rows through the
  runtime's own database adapter.
- `runtime.reconciliation` / `ReconciliationManager`: `active()`,
  `withoutPendingWork()`, `statesFor()`, and `orphaned()` bounded reads.
- `runtime.retention` / `RetentionManager`: `preview()` and authorized `prune()`
  for messages, instances, or processes.
- `runtime.doctor` / `Doctor`: `run({ roundTrip })` structured installation
  report.
- `runtime.testing` / `SolidObjectsTestHelper`: deterministic `drain()` and
  explicit-time `runDueReminders()`, plus dependency-ordered `reset()`.
- `runtime.realtime` / `RealtimeManager`: `connect()`, process-local
  `publish()`, and `close()`.

The manager types are `DeadLetter`; `ReminderPage`, `ReminderPageOptions`,
`ReminderRecord`, `ReminderStatus`, and `ResumeReminderOptions`;
`ProcessCleanupResult`, `ProcessMetadata`, `ProcessRecord`, and
`ProcessShutdownState`; `DoctorCheck`, `DoctorOptions`, `DoctorReport`, and
`DoctorStatus`; `OrphanedReconciliationOptions`,
`QuietReconciliationOptions`, `ReconciliationInstance`, `ReconciliationPage`,
`ReconciliationPageOptions`, and `ReconciliationStatesOptions`;
`RetentionOptions`, `RetentionResult`, and `RetentionTarget`; and
`RunDueRemindersOptions`, `TestDrainOptions`, and `TestHelperRole`.
`RealtimeConnectionOptions`,
`RealtimeSession`, and `SubscriptionRequest` define the server session API.
`AdministrationOptions` carries the application-owned authorization context
for administration calls.

The packaged `solid-objects quickstart` command is config-free and runs the
SQLite example shipped in the npm artifact. Every other CLI command loads the
application runtime configured through `--config`.

`ProcessRecord.shutdownState` is `"running"`, `"draining"`, or `"stopped"`;
there is no separate `running` field. `RetentionResult.count` means eligible
rows for `preview()` and rows actually deleted for `prune()`.

### Registration and integration

- `runtime.register(ActorClass)`: validate and register an actor definition.
- `runtime.ref(ActorClass, actorId)`: register and address an actor in an
  isolated runtime.
- `runtime.registerEffect(name, handler)`: register an at-least-once external
  effect handler. `EffectContext` carries the stable effect ID and source
  identity. Success operations receive `{ effectId, arguments, result }` and
  failure operations receive `{ effectId, arguments, error }`; `arguments` is
  the JSON object originally staged by `emit()`.
- `runtime.registerCommitAction(name, handler)`: register a same-database
  fenced transaction handler. `CommitActionContext` includes the active
  `DatabaseConnection`.
- `guardApplicationDatabase(database)`: return a facade that rejects writes
  from actor-owned execution contexts.
- `parseSubscriptionRequest(value)`: validate the server-side JSON subscribe or
  unsubscribe request before session routing.
- `runCli(arguments, options)` and `CliRunOptions`: embed and configure the
  packaged command implementation; applications normally invoke the
  `solid-objects` executable instead.

`SolidObjectsConfiguration`, `AuthorizationInput`,
`DestroyAuthorizationInput`, `AdministrationAuthorizationInput`,
`SubscriptionAuthorizationInput`, `BroadcastEvent`, and
`InstrumentationEvent` type the host integration contract. `JsonPrimitive`,
`JsonValue`, `JsonObject`, `DeepReadonly`, `ActorIdentifier`, `MessageContext`,
`MessageStatus`, and `Logger` are shared types. `Database`,
`DatabaseConnection`, `DatabaseFamily`, and `RunResult` support custom database
and commit-action integration.

`BroadcastEvent.observables` contains changed value-broadcast projections.
`BroadcastEvent.invalidations` contains changed invalidation-only names. The
runtime always supplies the array; consumers should treat its absence from an
older or application-produced event as an empty array.

### Runtime extensions and manual workers

`runtime.registerComponent(factory, { count = 1 })` adds application-owned
supervised roles. Each factory must return a `LongRunningComponent`:

```typescript
interface LongRunningComponent {
  run(signal: AbortSignal): Promise<void>
  requestShutdown(): void
  stopped(): boolean
  stop(): void | Promise<void>
}
```

The runtime creates `count` independent instances, replaces an instance whose
`run()` settles unexpectedly, and stops replacement before graceful shutdown.
Factories should create fresh mutable state and `stop()` should be idempotent.

`Worker`, `EffectWorker`, `ReminderScheduler`, and `BroadcastWorker` are
exported for test runners and hosts that intentionally operate roles outside
`runtime.run()`. Runtime factory methods create the same classes. Each provides
`runOnce()`, bounded `runUntilIdle()`, `run(signal)`, `requestShutdown()`,
`stopped()`, `stop()`, and the inspectable
`currentPollingIntervalMilliseconds`. Manual roles still register process
ownership and must be stopped. Prefer `runtime.run()` in production and
`runtime.testing` in tests.

`InProcessWakeUpAdapter`, `WakeUpAdapter`, `WakeUpRole`, `WakeUpWatch`, and
`WakeUpWaitOptions` define the notification extension. A watch must be obtained
before checking durable state so a notification cannot fall between claim and
wait. `WakeUpWatch.wait()` returns `true` for a notification and `false` for a
timeout or cancellation. A legacy `void` result remains accepted and preserves
the fast polling cadence.

### Errors

The root exports `SolidObjectsError` and its supported subclasses:

- policy and caller outcomes: `Unauthorized`, `Rejected`, `ActorDestroyed`,
  `SyncEnqueueTimeout`, `SyncTimeout`, `SyncInsideTransaction`, and
  `MessageFailed`;
- admission and payload failures: `MailboxFull`, `InvalidPayload`,
  `PayloadTooLarge`, `IdempotencyConflict`, `InvalidPayloadBroadcast`, and
  `UnknownPayloadBroadcast`;
- definition and execution failures: `InvalidActor`, `InvalidRejectionCode`,
  `UnknownActorType`,
  `UnknownOperation`, `ActorCallCycle`, `QueryMutatedState`,
  `StateMigrationError`, `ApplicationWriteForbidden`, `UnknownEffect`, and
  `UnknownCommitAction`;
- operational failures: `LostActivation`, `DatabaseDeadlineExceeded`,
  `UnknownDeadLetter`, `UnknownReminder`, `ReminderNotPaused`, and
  `UnsupportedDatabase`.

`NonRetryableError` is the application subclassing point. `SyncTimeoutDetails`
and `SyncTimeoutWaitingOn` type timeout diagnostics. See
[Errors and recovery](errors-and-recovery.md) before deciding what to catch.

## `solid-objects/database/sqlite`

- `sqlite(options)`: construct `SQLiteDatabase`.
- `SQLiteDatabase`: `Database` implementation and `close()` owner.
- `SQLiteDatabaseOptions`: path, busy timeout, and lock retry options.

## `solid-objects/database/sqlite-wasm`

- `sqliteWasm(options)`: construct `SQLiteWasmDatabase` asynchronously. The
  first call loads the `@sqlite.org/sqlite-wasm` module.
- `SQLiteWasmDatabase`: `Database` implementation on SQLite WASM and `close()`
  owner. It runs in a browser and in Node. One host owns the database file;
  the adapter serializes access on one connection.
- `SQLiteWasmDatabaseOptions`: `path` plus a `storage` mode. `"temporary"`
  (the default) keeps data for the life of the process or page.
  `"persistent"` stores data in the browser origin's OPFS through the SQLite
  SAH pool VFS, and fails fast where OPFS is unavailable.

## `solid-objects/database/postgresql`

- `postgresql(options)`: construct `PostgreSQLDatabase`.
- `PostgreSQLDatabase`: pooled `Database` implementation with `wakeUp()`.
- `PostgreSQLDatabaseOptions` and `PostgreSQLDatabaseWakeUpOptions`: pool and
  notification configuration.
- `postgresqlWakeUp(options)` and `PostgreSQLWakeUpAdapter`: standalone
  `LISTEN/NOTIFY` wake-up integration.
- `PostgreSQLWakeUpOptions` and `PostgreSQLWakeUpFailure`: listener options and
  failure callback data.

## `solid-objects/database/mysql`

- `mysql(options)`: construct `MySQLDatabase`.
- `MySQLDatabase`: pooled `mysql2` `Database` implementation.
- `MySQLDatabaseOptions`: pool configuration.
- `mysqlSql(sql)`: translate the portable conflict syntax used by custom
  database integrations.

## `solid-objects/wake-up/redis`

- `redisWakeUp(options)`: construct `RedisWakeUpAdapter`.
- `RedisWakeUpAdapter`: optional Pub/Sub latency layer.
- `RedisWakeUpOptions` and `RedisWakeUpFailure`: connection, channel, timeout,
  and failure callback types.

## `solid-objects/browser`

- `SolidObjectsBrowserClient`: connect, subscribe, unsubscribe, receive, and
  close a versioned WebSocket client without Node imports.
- `BrowserClientOptions`, `ActorSubscription`, `InvalidationEnvelope`,
  `PayloadEnvelope`, and `RealtimeEnvelope`: browser transport types.
- `parseInvalidation(value)` and `parseRealtimeEnvelope(value)`: validate and
  deeply freeze received JSON for custom transports.
- `SolidObjectsComponentRegistry`: register keyed observable dependencies,
  coalesce refreshes, abort superseded work, fence application, and close.
- `ComponentRegistration`, `RegisteredComponent`, `ComponentRefreshStrategy`,
  `ComponentRefreshRequest`, `ComponentRefreshResult`, `ComponentApplication`,
  `ComponentRefreshFailure`, and `ComponentRegistryOptions`: framework-neutral
  refresh contract types.

`InvalidationEnvelope.observables` contains values and
`InvalidationEnvelope.invalidations` contains names without values. The
component registry reacts to names in either location.

The wire format, trust boundary, revision rules, and component semantics are in
[Browser protocol](browser-protocol.md).

## `solid-objects/browser/host`

The entry point for a runtime host inside a browser worker. An import of
this module registers the browser platform: a turn-scoped context store and
a browser host identity. Do not import it in the same process as the Node
entry points; the last registration wins.

- Re-exports `Actor`, `broadcastInvalidation`, `broadcastValue`, `configure`,
  `createRuntime`, `SolidObjectsRuntime`, and `VERSION` from the core, and
  `sqliteWasm`, `SQLiteWasmDatabase`, and `SQLiteWasmDatabaseOptions` from
  the WASM adapter, so a worker needs one import.
- The turn-scoped context store expects serialized actor turns. One worker
  hosts one runtime. A page talks to that worker through messages, not
  through direct actor references.
- The store scopes only the synchronous part of a callback and restores
  the previous scope in strict stack order, so an interleaved task never
  observes another turn's scope. The cost of that isolation: after the
  first `await` inside an actor operation, `currentActor()`,
  `applicationWritesForbidden()`, and the database deadline read as unset.
  Keep guarded application-database writes in synchronous actor code or in
  commit actions; Node keeps full `AsyncLocalStorage` propagation.
- Alarms and reminders fire only while the hosting worker is alive.

## `solid-objects/browser/tab-host`

Many tabs, one runtime. Each tab starts a candidate host; the Web Locks API
elects one leader per origin. The leader starts the runtime, runs its
workers, and serves invocations from every tab over a `BroadcastChannel`.
When the leader's tab dies, the lock releases and the next host promotes.

- `startTabHost(options)`: join the election. `TabHostOptions` carries the
  election `name` and a `startRuntime` callback; the callback runs only on
  promotion, so a follower never opens the database. It returns a
  `TabHostRuntimeHandle` with the runtime and an optional `close`.
- `TabHost`: `role()`, `leadership()` (a promise that resolves on
  promotion), and `close()`.
- `connectTabClient(options)`: connect from any tab. `TabClientOptions`
  carries the election `name` plus retry and timeout intervals.
- `TabClient.invoke(invocation)`: send a `TabInvocation` (`actorType`,
  `actorId`, `operation`, `arguments`). The client retries until a leader
  answers; the leader enqueues with the request id as the idempotency key,
  so a resend applies once.
- `TabInvocationTimeout` and `TabInvocationFailed`: the client-side errors.

The election needs the Web Locks API. Every current browser provides it;
Node provides `navigator.locks` from 24.5, so Node-side use of this module
needs a newer Node than the package floor. `startTabHost` fails fast with a
clear error where the API is missing.

A tab dies without a clean shutdown, so failover speed follows the fence
settings. Give the browser runtime a short `leaseDurationMilliseconds` and
`processAliveThresholdMilliseconds` (for example 750), with a
`leaseRenewalIntervalMilliseconds` below the lease (for example 250), so a
new leader reclaims a dead tab's activations before sync invocations time
out. When `startRuntime` fails, close the database in a catch block; an
open SAH pool otherwise blocks the next candidate until the worker dies.

## `solid-objects/sync-bridge`

The transactional outbox bridge between a local runtime and a server
runtime. An actor stages a sync intent with `emit(SYNC_BRIDGE_EFFECT, ...)`
in the same transaction as its state change. The effect worker drains the
outbox with at-least-once delivery, per-actor order, and retry backoff.

- `SYNC_BRIDGE_EFFECT`: the effect name (`solid-objects.sync`). The staged
  arguments hold `operation`, `arguments`, and an optional target
  `actorType` and `actorId`; the target defaults to the source actor.
- `registerSyncBridge(options)`: register the drain handler on the local
  runtime. `SyncBridgeOptions` carries the runtime and a `transmit`
  callback that carries a `SyncEnvelope` to the server; throw from
  `transmit` while offline and the effect retries with backoff. Give a
  browser runtime a generous `maxAttempts`; an effect that exhausts its
  attempts during a long offline period lands in dead letters, and
  `runtime.deadLetters.retry` re-queues it.
- `receiveSyncEnvelope(options)`: idempotent server ingest. It enqueues an
  internal message with `sync:<effectId>` as the idempotency key, so a
  replayed envelope applies once. The host must authenticate the sender
  before this call; internal delivery skips `authorizeMessage`.
- Per-actor order comes from an ordered drain: a claimed sync effect
  transmits every undelivered envelope for its actor up to its own mailbox
  sequence, oldest first. A duplicate transmission is safe; the server
  deduplicates by effect id. Run one effect worker per local runtime for
  the order guarantee.
- `InvalidSyncEnvelope`: the non-retryable rejection for malformed staged
  arguments; the effect dead-letters instead of retrying forever.

Both modules are browser-safe and also run in Node.

## `solid-objects/web`

- `createDashboard(options)` creates an immutable `SolidObjectsDashboard` with
  a standard `fetch(request, context)` entry point.
- `createNodeDashboardHandler(options)` adapts the Fetch entry point to
  `node:http` and Connect-compatible middleware.
- `DashboardOptions` selects the runtime, mount path, `DashboardAccess`, chart library,
  `DashboardExtension` objects, and `DashboardMiddleware` functions.
- `DashboardRequestContext` supplies the existing administration authorization
  context and an optional `DashboardSession`. Read/write access requires the
  session, because its `read()` and `write()` methods hold the masked CSRF token
  across requests. Read-only modes create no CSRF state.
- `DashboardRoute`, `DashboardRouteContext`, `DashboardPolicy`, `DashboardPage`,
  and `DashboardTab` define extension pages. Every route requires a policy.
- `DashboardRenderer`, `DashboardRenderInput`, and `DashboardMiddlewareInput`
  define immutable view overrides and middleware inputs.
- `DashboardChartLibrary` selects the CDN, a self-hosted script, or disabled
  charts.
- `NodeDashboardHandler`, `NodeDashboardHandlerOptions`, and
  `NodeDashboardRequestContextResolver` describe the Node adapter.
- `SolidObjectsDashboardContract` is the minimal Fetch contract accepted by the
  Node adapter.

Mounting, authorization actions, CSRF behavior, pages, and extensions are in
[Operator dashboard](dashboard.md).

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
- `Actor`: base class providing `ref()`, `actorId`, `currentMessage`,
  `observables()`, `reject()`, `emit()`, `commitAction()`, `schedule()`,
  `sendTo()`, and protected lifecycle hooks.
- `VERSION`: running package version.
- `ActorClass`, `ActorReference`, `ActorMessageSender`, `ActorSnapshot`,
  `ActorOperationNames`, `ActorQueryNames`, `StagedOperations`, and
  `ScheduledOperations`: inferred actor-class and fluent-dispatch types.
- `MessageReference`: immutable durable message identity with `id`,
  `requestId`, actor identity, `sequence`, `status()`, `result()`, and `wait()`.
- `InvocationOptions`, `AsyncInvocationOptions`, `SnapshotOptions`, and
  `DestroyOptions`: authorization, idempotency, timing, and scheduling options
  used by reference methods.

`ActorIntents`, `EffectIntent`, `CommitActionIntent`, `ReminderIntent`,
`OutboundMessageIntent`, `ReminderOptions`, `OutboundMessageOptions`,
`PayloadBroadcasts`, and `PayloadBroadcastValue` describe actor-declared
transactional work and typed personalized projections.

### Runtime managers

Every manager below is available as a property on `SolidObjectsRuntime`; the
class and result types are also exported for integration typing.

- `runtime.deadLetters` / `DeadLetterManager`: `all()` and idempotent `retry()`.
- `runtime.reminders` / `ReminderManager`: cursor-paginated `all()` and
  idempotent paused-alarm `resume()`.
- `runtime.processes` / `ProcessManager`: immutable role `all()` and stale-owner
  `cleanup()`.
- `runtime.reconciliation` / `ReconciliationManager`: `active()`,
  `withoutPendingWork()`, `statesFor()`, and `orphaned()` bounded reads.
- `runtime.retention` / `RetentionManager`: `preview()` and authorized `prune()`
  for messages, instances, or processes.
- `runtime.doctor` / `Doctor`: `run({ roundTrip })` structured installation
  report.
- `runtime.testing` / `SolidObjectsTestHelper`: deterministic `drain()` and
  dependency-ordered `reset()`.
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
`TestDrainOptions` and `TestHelperRole`. `RealtimeConnectionOptions`,
`RealtimeSession`, and `SubscriptionRequest` define the server session API.
`AdministrationOptions` carries the application-owned authorization context
for administration calls.

### Registration and integration

- `runtime.register(ActorClass)`: validate and register an actor definition.
- `runtime.ref(ActorClass, actorId)`: register and address an actor in an
  isolated runtime.
- `runtime.registerEffect(name, handler)`: register an at-least-once external
  effect handler. `EffectContext` carries the stable effect ID and source
  identity.
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
`stopped()`, and `stop()`. Manual roles still register process ownership and
must be stopped. Prefer `runtime.run()` in production and `runtime.testing` in
tests.

`InProcessWakeUpAdapter`, `WakeUpAdapter`, `WakeUpRole`, `WakeUpWatch`, and
`WakeUpWaitOptions` define the notification extension. A watch must be obtained
before checking durable state so a notification cannot fall between claim and
wait.

### Errors

The root exports `SolidObjectsError` and its supported subclasses:

- policy and caller outcomes: `Unauthorized`, `Rejected`, `ActorDestroyed`,
  `SyncEnqueueTimeout`, `SyncTimeout`, `SyncInsideTransaction`, and
  `MessageFailed`;
- admission and payload failures: `MailboxFull`, `InvalidPayload`,
  `PayloadTooLarge`, `IdempotencyConflict`, `InvalidPayloadBroadcast`, and
  `UnknownPayloadBroadcast`;
- definition and execution failures: `InvalidActor`, `UnknownActorType`,
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

The wire format, trust boundary, revision rules, and component semantics are in
[Browser protocol](browser-protocol.md).

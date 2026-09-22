# Operations

`install()` prepares the database and starts nothing. A process serves
background work only after `runtime.run(signal)` starts its roles. A process
that registers actors, installs, and then waits never claims a ready message,
and work enqueued with `send` stays ready until some process runs the roles.
A direct call or an explicit `sync` needs no running role, because the caller's
own path executes it.

Runtime roles use durable polling as the correctness fallback. Consecutive
empty passes double each role's wait from `pollingIntervalMilliseconds` to
`idlePollingIntervalMilliseconds`, which defaults to one second. Processed
work and wake-up notifications reset the role to the fast interval. Actor
workers clamp the ceiling to `leaseRenewalIntervalMilliseconds` while they may
hold cached activations.

The runtime selects a wake-up adapter on first use. It prefers
`SOLID_OBJECTS_REDIS_URL`, then PostgreSQL notifications, then polling.
The generation-based in-process adapter interrupts waits for new actor
messages, effects, reminders, and broadcasts in the same Node process. It does
not cross a process boundary. When live processes share the database and the
installed adapter does not cross processes, the runtime logs
`solid_objects.polling_only_cross_process_wake_up` once. Without a
cross-process adapter, newly committed work can wait for the current idle
polling interval. The runtime isolates notification errors and logs them by
role and error class. The committed work does not fail.

`runtime.wakeUpCapability()` and the `wakeUp` doctor check report the adapter
that is installed, whether it crosses processes, its measured floor, and why it
was chosen. On PostgreSQL, selection first proves the path: it listens on a
probe channel, notifies it from a second connection, and waits for the
notification. A probe that does not arrive logs
`solid_objects.wake_up.pooled_session` once and falls back to polling, because
`LISTEN` does not survive a transaction pooler such as PgBouncer.

The warning excludes process rows with the current hostname and host process ID.
It can therefore appear during a rolling deployment or restart overlap when an
older and newer process briefly share the same database. A process that stopped
without graceful cleanup remains live until its heartbeat exceeds
`processAliveThresholdMilliseconds`; inspect
`runtime.administration.processes()` to distinguish a live overlap from a stale
row.

Each role exposes `currentPollingIntervalMilliseconds`.
`solid_objects.polling.interval_changed` reports the role, reason, previous
interval, and current interval. The polling-only warning is also emitted as
`solid_objects.polling.only_cross_process_wake_up` instrumentation.

Graceful shutdown stops new claims and allows active turns to finish within
`shutdownTimeoutMilliseconds`, which defaults to 15 seconds. A component still
running or stopping at the deadline emits
`solid_objects.supervisor.component_shutdown_timeout`; the runtime then returns
without pretending JavaScript code was forcibly terminated. Operators should
monitor oldest ready work, claimed work, dead letters, effect failures,
reminder lag, lease loss, process heartbeats, and database contention.

`runtime.run()` replaces built-in roles and registered application components
that return or reject before shutdown. `supervisorRestartDelayMilliseconds`
defaults to 100 ms and doubles after consecutive run or construction failures,
capped by `supervisorMaximumRestartDelayMilliseconds` at 10 seconds. Replacement
and replacement-failure events contain the role class, failure count, and error
class only. Repeated failure messages are excluded from instrumentation.

`maxMessagesPerActivationPass` defaults to 50 and
`maxActivationDurationMilliseconds` defaults to 5 seconds. A pass yields when
either budget is exhausted. Lower values improve fairness when a few actor
identities stay continuously busy; higher values reduce claim overhead for
isolated backlogs. `solid_objects.activation.yielded` reports the actor
identity, turns processed, and remaining due membership count.

`claimScanLimit` defaults to 100. Global claims inspect a bounded ordered set of
actor identities. They continue after a lost lease race. Worker parallelism
stays, and the scan stays bounded.

Workers retain a hydrated actor and its fenced lease for
`idleDeactivationTimeoutMilliseconds`, which defaults to 30 seconds. Idle
leases renew at `leaseRenewalIntervalMilliseconds`; the worker polling cadence
is capped at that interval while any activation may be cached. Fairness yield,
lease loss, timeout, and shutdown release the lease. `runUntilIdle()` and the
runtime's synchronous caller release before returning because they are no
longer polling.

Actors can override protected `onActivate()` and `onDeactivate()` methods for
nondurable, process-local resources. Either hook may be asynchronous. Hook code
runs under the application-write guard. `onDeactivate()` is best effort:

- it may not run after a crash;
- it cannot establish a correctness guarantee;
- the runtime logs a failure and still releases the lease.

`runtime.administration.processes()` returns the same administration-authorized
immutable process metadata as `runtime.processes.all()`, with hostname, host
process ID, Node and Solid Objects versions, and a current `stale` flag. You can
safely call it through the runtime's database adapter while the workers run. The
runtime serializes the query with the other database access, and it needs no
second SQLite connection. Graceful shutdown first persists `draining` with a
`shutdownRequestedAt` timestamp, then deactivates owned actors and atomically
releases every role claim before persisting `stopped`. `cleanup()` reauthorizes
separately and performs the same release for stale running or draining
processes. The cleanup count is instrumented; application payloads are not.

Committed calls and `message.wait()` apply `timeoutMilliseconds` to the entire
durable wait. The clock starts before enqueue or message lookup. Adapter
deadlines
bound serialized SQLite access and lock waits, PostgreSQL pool acquisition,
statements, and locks, and MySQL pool acquisition, queries, and transaction
lock waits. A `SyncEnqueueTimeout` means the enqueue transaction did not commit
and there is no durable message to recover. Once enqueue commits, a
`SyncTimeout` includes `waitingOn`, activation and process metadata, an earlier
blocking message when present, and the original `messageReference`. Database
contention that prevents inspection is reported as `databaseContention`. The
durable message continues after an ordinary wait timeout, so callers can store
that reference or await `error.messageReference.wait()` later. Timeout
instrumentation excludes actor arguments, results, and error messages.

JavaScript promises already running in the process are cooperative and are not
forcefully terminated. An actor operation that has started may therefore
finish after the caller's timeout; durable leases and fenced commits remain the
correctness boundary.

Committed calls and `message.wait()` fail with `SyncInsideTransaction` when
invoked inside `database.transaction(...)` on the configured Solid Objects
adapter. The check happens before enqueue for direct calls. This prevents the
caller from waiting on a pool connection or SQLite access slot that its own
ambient transaction still holds.

Authorized operators can inspect terminal actor failures with
`runtime.deadLetters.all()` and retry one with `runtime.deadLetters.retry()`.
Retry is idempotent per dead letter: the record retains the replacement message
ID and later calls return a reference to that same message.

Self-scheduling actors need a low-frequency reconciler because application
alarms can still be lost. `runtime.reconciliation` provides administration-
authorized, read-only views for:

- active instances;
- quiet instances with no ready work, claimed work, or scheduled reminder;
- migrated state batches;
- orphaned actor IDs.

Collection reads use a maximum page size of 1,000 and a stable cursor.

The host application supplies its current owner IDs to `orphaned()` because
Node applications do not share an Active Record relation abstraction. Send
every repair through the actor's typed `send` dispatcher, optionally with a
future `availableAt` to spread large repairs. Never update persisted actor
state from reconciliation code.

The runtime automatically prunes expired message and stopped-process history
once at startup and every `retentionIntervalMilliseconds`, which defaults to
one hour. Stale process ownership is recovered independently every
`deadProcessCleanupIntervalMilliseconds`, which defaults to one minute. Set an
interval to zero to disable its scheduler. Failed passes emit metadata-only
events and retry with bounded exponential backoff without stopping other
runtime roles.

Operators can also use `runtime.retention.preview()` and
`runtime.retention.prune()`. Both calls require administration authorization;
use preview first and alert on an unexpected count before executing deletion.
Message history defaults to 30 days with optional per-actor overrides. Stopped
process history defaults to 7 days. Instance expiration is disabled unless an
actor type appears in `instanceRetentionByActorType`, and remains an explicit
operator action because it deletes the entire actor incarnation.

Pruning selects and rechecks at most `pruneBatchSize` rows per transaction. It
keeps:

- ready and claimed messages;
- dead-letter originals and replacements;
- unfinished effects and broadcasts;
- scheduled reminders;
- leased or paused instances;
- processes that still own a claim or an activation.

Instance
expiration removes the entire actor incarnation and all of its retained
history, so use it only for actor types whose state is safely disposable.

`runtime.doctor.run()` returns structured configuration, schema, database,
authorization-posture, live-role, and durable-round-trip checks. A warning does
not make the report unhealthy; a failed check does. The round trip targets only
its probe actor, uses the ordinary lease and fenced commit path, and removes its
instance and process records afterward. Use `{ roundTrip: "skip" }` when the
diagnostic must not write.

The doctor reports whether each authorization callback was explicitly
configured and probes all configured policies with a neutral context. It warns
when every policy denies the probe, a policy needs unavailable application
context, or destruction, subscription, or administration allows it. The probe
does not replace application-specific authorization tests. Do not expose the
report through an HTTP or CLI surface without applying the host application's
own administration policy.

The packaged `solid-objects` executable loads a configured runtime exported as
default or `runtime` from `solid-objects.config.js`, or from `--config PATH`.
It provides `start`, `doctor`, `status`, `cleanup`, `dead-letters`,
`retry-dead-letter`, `reminders`, `resume-reminder`, and `prune`. Output is JSON,
and destructive retention requires `prune TARGET --execute`; the unqualified
command is a preview. Administrative commands consistently pass
`{ source: "cli" }` through the ordinary policy boundary.

Tests can use `runtime.testing.drain()` to process reminders, actor turns,
effects, actor callbacks, and broadcasts in deterministic passes. The helper
stops every temporary runner even when a handler raises. `reset()` must only run
while the supervised runtime is stopped; it explicitly clears child tables,
instances, and process records and replaces the cached synchronous caller.

The optional `instrumentation` callback receives immutable events with the
`solid_objects.` prefix. Core events cover runtime lifecycle, message
enqueue/start/completion/rejection/failure, activation loss, commit actions,
effects, reminders, broadcasts, dead letters, worker setup failures, actor
destruction, and retention pruning. Failed realtime delivery emits
`subscription.delivery_failed` and
removes that session's actor registration without retrying application socket
code. Event attributes are restricted to identities, operation or handler
names, delivery mode, sequence, attempt, outcome, counts, durations, and error
class names. The runtime catches sink exceptions and reports only the failed
event name and sink error class through the configured logger.

`runtime.reminders.all()` provides administration-authorized, cursor-paginated
alarm metadata filtered by actor type or status. Arguments and error messages
remain private. `resume()` moves a paused reminder back to `scheduled`, clears
its claim and stored error, and optionally assigns a new run time. Repeating
resume on an already scheduled reminder is a no-op; completed reminders cannot
be resumed.

Scheduling an existing actor operation for a different time emits
`solid_objects.reminder.replaced` after the fenced actor commit. Scheduling it
for the same time emits nothing.

## Dead letters, retry, and redrive

A message that exhausts its attempts becomes a dead letter. An effect or a
broadcast that exhausts its attempts stays in its own table with
`status = 'dead'`. All three are read and retried through one receiver, which
carries the kind:

```ts
await runtime.deadLetters.all({ authorizationContext })
await runtime.deadLetters.retry(deadLetterId, { authorizationContext })

await runtime.deadLetters.effects.all({ authorizationContext })
await runtime.deadLetters.effects.retry(effectId, { authorizationContext })
await runtime.deadLetters.broadcasts.retry(broadcastId, { authorizationContext })
```

An effect or broadcast retry returns the row to pending with a zero attempt
count, no claim, and immediate availability, and keeps its id, so a handler that
deduplicates on the effect id still sees the same key. An effect is
at-least-once by contract, so a retried effect can run twice.

Retry acts only on a dead row. A row that is pending, processing, or completed
comes back unchanged, so pressing a button twice cannot double-enqueue and
cannot take a row away from a worker that holds it.

An incident produces dead rows in the hundreds, so a scope also answers
`redrive`:

```ts
const task = await runtime.deadLetters.effects.redrive({
  actorType: "payments",
  failedAfter: new Date(Date.now() - 6 * 60 * 60 * 1000),
  limit: 5_000,
  authorizationContext,
})

await task.cancel({ authorizationContext })
```

`redrive` returns at once. The task is durable, and `runtime.run()` advances one
bounded batch per pass, so a redrive of thousands of rows never holds a
transaction longer than one batch. `redriveBatchSize` defaults to 100 and
`redriveBatchPauseMilliseconds` to 50.

A redrive moves the rows that were already dead when it started. A row that
fails again lands back in the same scope, and without that bound a task whose
handler is still broken would move it forever.

A redrive is idempotent over its scope and its filters. Starting the same one
while it runs returns the running task rather than a second one, which a
dashboard button an operator can press twice needs. A different scope or a
different filter starts its own task, and the same scope can be redriven again
once the first task finishes.

Read tasks back with `runtime.redrives`:

```ts
await runtime.redrives.find(task.id, { authorizationContext })
await runtime.redrives.all({ status: "running", authorizationContext })
```

A running task reports what is left to move rather than a stored estimate,
because rows die and are retried while it runs.

Retry, redrive, and cancel each go through `authorizeAdministration` under their
own resource name: `dead_letters`, `effect_dead_letters`,
`broadcast_dead_letters`, and `redrives`. Every retry and every task transition
writes one row to `solid_objects_administration_events`, holding the action, the
kind, the subject, the identity, and when it happened. The identity comes from
`administrationIdentity`, which receives the authorization context the caller
passed and defaults to its `String` form.

An event records an authorized press, not a state transition. Pressing retry
twice writes two rows, because an operator did two things and a log that shows
one cannot answer who pressed what. The row the event names carries the outcome.
A refused caller writes nothing, and a retry that raises after the lookup writes
nothing, because the event shares the transaction with the work. The redrive
transitions are different: `redrive.start`, `redrive.finish`, and
`redrive.cancel` are written only when the task actually changes.

The Durable Objects engine keeps its own message and outbox tables inside each
object, so these scopes and redrive cover the SQL backends. `deadLetters` there
reports its own dead rows as it did before.

Automatic redrive on a schedule is deliberately absent. A dead row means a
person decided something, and these APIs give that person an alternative to an
`UPDATE` against a runtime table.

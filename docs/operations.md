# Operations

Runtime roles use durable polling as the correctness fallback. The default
generation-based wake-up adapter interrupts waits for new actor messages,
effects, reminders, and broadcasts in the same Node process. Notification
errors are isolated and logged by role and error class without failing the
committed work. Graceful shutdown stops new claims and allows active turns to
finish within `shutdownTimeoutMilliseconds`, which defaults to 15 seconds. A
component still running or stopping at the deadline emits
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
actor identities and continue after a lost lease race, preserving worker
parallelism without an unbounded scan.

Workers retain a hydrated actor and its fenced lease for
`idleDeactivationTimeoutMilliseconds`, which defaults to 30 seconds. Idle
leases renew at `leaseRenewalIntervalMilliseconds`; the worker polling cadence
is capped at that interval while any activation may be cached. Fairness yield,
lease loss, timeout, and shutdown release the lease. `runUntilIdle()` and the
runtime's synchronous caller release before returning because they are no
longer polling.

Actors can override protected `onActivate()` and `onDeactivate()` methods for
nondurable, process-local resources. Either hook may be asynchronous. Hook code
runs under the application-write guard, and `onDeactivate()` is best effort:
it may not run after a crash, cannot establish a correctness guarantee, and a
failure is logged without preventing lease release.

`runtime.processes.all()` returns administration-authorized immutable process
metadata with hostname, host process ID, Node and Solid Objects versions, and a
current `stale` flag. `cleanup()` reauthorizes separately and atomically fences
stale processes out of every owned role claim before waking the affected
runtime roles. The cleanup count is instrumented; application payloads are not.

Committed calls and `message.wait()` apply `timeoutMilliseconds` to the entire
durable wait, beginning before enqueue or message lookup. Adapter deadlines
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
authorized, read-only views for active instances, quiet instances without
ready work, claimed work, or scheduled reminders, migrated state batches, and
orphaned actor IDs. Collection reads use a maximum page size of 1,000 and a
stable cursor.

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
preserves ready and claimed messages, dead-letter originals and replacements,
unfinished effects and broadcasts, scheduled reminders, leased or paused
instances, and processes that still own a claim or activation. Instance
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
effects, reminders, broadcasts, dead letters, actor destruction, and retention
pruning. Failed realtime delivery emits `subscription.delivery_failed` and
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

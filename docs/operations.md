# Operations

Runtime roles use durable polling as the correctness fallback. Graceful shutdown
stops new claims and allows active turns to finish. Operators should monitor
oldest ready work, claimed work, dead letters, effect failures, reminder lag,
lease loss, process heartbeats, and database contention.

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

Retention is explicit through `runtime.retention.preview()` and
`runtime.retention.prune()`. Both calls require administration authorization;
use preview first and alert on an unexpected count before executing deletion.
Message history defaults to 30 days with optional per-actor overrides. Stopped
process history defaults to 7 days. Instance expiration is disabled unless an
actor type appears in `instanceRetentionByActorType`.

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
configured without calling it. Do not expose the report through an HTTP or CLI
surface without applying the host application's own administration policy.

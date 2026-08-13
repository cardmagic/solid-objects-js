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

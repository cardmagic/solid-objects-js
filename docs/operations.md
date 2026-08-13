# Operations

Runtime roles use durable polling as the correctness fallback. Graceful shutdown
stops new claims and allows active turns to finish. Operators should monitor
oldest ready work, claimed work, dead letters, effect failures, reminder lag,
lease loss, process heartbeats, and database contention.

Authorized operators can inspect terminal actor failures with
`runtime.deadLetters.all()` and retry one with `runtime.deadLetters.retry()`.
Retry is idempotent per dead letter: the record retains the replacement message
ID and later calls return a reference to that same message.

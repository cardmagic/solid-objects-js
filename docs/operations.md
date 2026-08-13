# Operations

Runtime roles use durable polling as the correctness fallback. Graceful shutdown
stops new claims and allows active turns to finish. Operators should monitor
oldest ready work, claimed work, dead letters, effect failures, reminder lag,
lease loss, process heartbeats, and database contention.

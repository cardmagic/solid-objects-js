# Effect recovery coordination

Install the additive schema migration and upgrade all effect workers and process
cleanup roles before emitting recovery-enabled effects. Older runtime versions
do not honor the persisted recovery bindings or the new lock protocol.

The single `emit` API allocates a stable effect ID at staging and returns its
JSON handle. The fenced actor commit persists the effect, actor state, and
optional recovery/status binding together. `requestEffectRecovery` stages a
check on that same transaction connection. It never opens another transaction
while an application commit action holds locks.

Automatic polling checks at most `claimScanLimit` stale candidates per pass,
prefiltering with database time, owner heartbeat, and the effective timeout. It
does not lock fresh owners or their actors, even when the global liveness floor
has elapsed but an effect's extended grace has not. Each candidate gets one
independent transaction; unlocked candidate reads remain hints only. Lock order is origin
instance, effects ordered by ID, recovery bindings ordered by effect ID, then
current owner processes ordered by ID. Explicit batches acquire all effect and
binding locks before any process locks. Completion/failure lock the instance
before the effect. Pending claims lock the effect and never subsequently lock
the instance. Mailbox insertion reuses the origin instance lock.

After waiting for these locks, the decision uses current ownership, a locked
heartbeat, database wall time, and the maximum of the current runtime threshold
and the persisted per-effect override. Missing owners are stale; query errors
are errors. Process shutdown preserves heartbeat evidence and opted-in claims.
Process pruning excludes effect owners; later polling revisits stopped owners
until each effect's individual grace expires. Ordinary effects and pending
retries retain their scheduler behavior.

Retirement records `retired_at_ms` in `effect_recoveries`, clears the claim, and
uses the existing terminal `completed` effect storage state. The durable binding
distinguishes retirement from successful completion and is checked first by all
recovery observations. No success callback is generated. This avoids rewriting
existing status constraints across PostgreSQL, MySQL, and SQLite. Internal
effect-table status alone is not the recovery outcome. Late completion/failure
must still match a processing claim, which retirement removes.

The terminal transition and `effect:<id>:recovery` mailbox insertion are atomic.
A winning explicit check additionally enqueues its separate status response,
after recovery, keyed by `effect:<id>:check:<internal-request-id>`. Failure of
either insertion rolls the transaction back. Multiple checks share one durable
retirement, with one response per request. A crash after commit cannot lose the
recovery callback. Successful retirement wakes actor workers after commit.
Wake-up failures are logged without changing the committed decision; mailbox
polling provides delivery.

Bindings belong to the exact originating instance, survive effect/message
pruning, and cascade when the instance is deleted. They neither pin instances nor
authorize cross-actor access. Within that retention lifetime a pruned effect can
report missing or already retired. Outside it, checks fail. Message idempotency
has normal mailbox retention; applications cannot supply internal request IDs.

See [the watchdog example](api.md#recovering-abandoned-effects). Success and
completed-status repair use one application guard; status never owns replacement.
External systems still require idempotency across retries and replacement
generations. Stale heartbeat evidence grants library recovery permission; it
does not prove the previous handler or remote operation stopped.

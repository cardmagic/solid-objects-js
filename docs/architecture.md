# Architecture

Solid Objects coordinates stateful TypeScript objects through database-backed
mailboxes. Each object, called an actor in the API, is addressed by
`(actor type, actor id)`, processes one durable turn at a time, and persists
JSON state between activations.

A durable message envelope selects an actor `operation` and records its
`delivery_mode` as `async`, `sync`, or `internal`. An operation is actor code;
a message is the durable delivery record that invokes it. Each message has a
generated request ID independent of its optional caller-supplied idempotency
key. Matching idempotency keys are scoped to one actor and must identify the
same operation, delivery mode, and arguments.

The correctness contract is:

> Messages for one actor are durably enqueued and processed sequentially, at
> least once, by at most one valid activation lease holder at a time.

Actor code runs outside the database transaction. A short transaction guarded
by the activation owner, token, generation, expiration, and claimed-message
membership commits state, completion, and staged outboxes together.

Each role takes a generation watch before checking for work. A post-commit
wake-up therefore cannot fall into the gap between an empty claim and the
worker's wait. The default adapter broadcasts within one process; polling
remains active as the durable fallback and custom adapters can bridge process
boundaries. Empty passes double the role's wait up to the configured idle
ceiling. Work or a notification resets it to the fast interval, and an actor
worker's ceiling never exceeds its lease-renewal interval.

Each runtime role occupies a supervised factory slot. An unexpected promise
resolution or rejection cleans up that instance, waits with capped exponential
backoff, and builds the replacement through the same factory. Supervision stops
at the shutdown boundary; database leases and fencing remain the correctness
mechanism if a failed role was still executing actor code.

SQLite serializes access through one process-local connection and begins write
transactions immediately. PostgreSQL and MySQL use bounded pools, keep each
transaction on one checked-out client, store timestamps and sequences as
64-bit integers, and lock an actor's instance row while allocating mailbox
sequences. MySQL creates InnoDB tables and retries only the side-effect-free
enqueue transaction when InnoDB chooses it as a deadlock victim. Every adapter
uses database time and the same fencing predicates.

Synchronous invocation carries a monotonic deadline into adapter operations.
SQLite bounds its process-local access queue and busy timeout. Outside a caller
deadline, it retries only acquisition of a failed `BEGIN IMMEDIATE`; it never
replays a transaction callback. PostgreSQL bounds pool checkout and installs
statement and lock timeouts. MySQL bounds pool checkout and client queries and
installs transaction execution and lock-wait limits. A deadline before enqueue
commit produces no durable message. After commit, timeout diagnostics retain
the message reference for later recovery.
Already-running JavaScript actor code is cooperative rather than forcefully
preempted; leases and fenced commits remain authoritative if it outlives the
caller's wait.

Each database adapter also tracks its active transaction through Node's async
context. A committed call or message wait fails before enqueue or polling when
the same logical call stack already owns a Solid Objects transaction, rather
than waiting for a connection or serialized SQLite slot it cannot release.

PostgreSQL notifications are an opt-in latency layer. One event-driven client
per runtime listens on role-specific channels before the worker checks durable
state, which closes the listener-startup race without holding a polling
connection per worker. A notification advances a process-local role generation
and wakes every matching waiter. Reconnection and notification loss fall back
to adaptive polling, whose current wait can be as long as the configured idle
ceiling.

The optional Redis adapter provides the same role generations through Pub/Sub
for deployments that already operate Redis. It keeps commands and subscriptions
on separate lazy connections. Connect, subscribe, and publish failures are
bounded and isolated; durable polling continues independently.

A worker claims one actor globally, then preferentially drains up to
`maxMessagesPerActivationPass` ready turns for that instance. Reaching the cap
moves only that actor's already-due ready memberships to current database time.
Actors with older ready work therefore win the next global claim; delayed work
keeps its original future availability.

The global claim reads at most `claimScanLimit` ordered candidates. If another
worker acquires the first candidate's lease, the transaction continues through
that bounded set instead of returning idle and sacrificing parallelism across
independent actor identities.

When a pass becomes idle, a long-running worker keeps the hydrated actor and
continues renewing the same fenced lease until its idle timeout. A later turn
on that actor reuses both its persisted public fields and process-local private
fields. Failed and rejected turns restore public fields to their pre-turn
values before reuse. Fairness yield, timeout, lease loss, and shutdown run the
best-effort deactivation hook and conditionally release the matching lease.
One-shot drain helpers release immediately because they will not remain alive
to renew.

Realtime delivery is transport-neutral. A host-authenticated session authorizes
actor subscriptions, replays a committed observable projection, and follows
the durable broadcast outbox in revision order. The browser client applies the
same incarnation and revision fence without importing Node APIs.

Each observable is compared using its computed JSON value. Value-broadcast
observables persist that changed value in the outbox; invalidation-only
observables persist only the changed name. This lets a component registry
refresh a reauthorized view at the same dependency granularity without storing
or sending private projection values.

Actors may also declare static personalized payload projections. Each requested
name is reauthorized as a query and evaluated against a fresh actor hydrated
from committed state under that subscriber's session context. Payload names use
independent revision fences, so a failed projection is omitted and retried at a
later committed revision without blocking invalidations or sibling payloads.
Actors with payload declarations emit an empty-observable revision event for a
state change when no scalar observable changed.

Sessions are process-local. A multi-process deployment bridges committed
broadcast events through an application-owned shared transport and calls
`runtime.realtime.publish()` in each process that owns connections. This keeps
another broker optional for a single Node process while making the
cross-process boundary explicit.

Solid Objects provides database-backed state coordination for Node.js. It does
not reproduce Cloudflare's placement or edge-runtime guarantees.

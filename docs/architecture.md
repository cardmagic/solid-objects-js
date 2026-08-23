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

> Solid Objects durably enqueues the messages for one actor. At most one valid
> activation lease holder processes them at a time, in sequence, and at least
> once.

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
transactions immediately. PostgreSQL and MySQL use bounded pools. They keep each
transaction on one checked-out client. They store timestamps and sequences as
64-bit integers. They lock an actor's instance row during mailbox sequence
allocation. MySQL creates InnoDB tables and retries only the side-effect-free
enqueue transaction when InnoDB chooses it as a deadlock victim. SQLite WASM
serializes one in-process connection the same way as the Node SQLite adapter.
It stores its file in the browser origin's OPFS through the SAH pool VFS.
Every adapter uses database time and the same fencing predicates.

Synchronous invocation carries a monotonic deadline into adapter operations.
SQLite bounds its process-local access queue and busy timeout. Outside a caller
deadline, it retries only acquisition of a failed `BEGIN IMMEDIATE`; it never
replays a transaction callback. PostgreSQL bounds pool checkout and installs
statement and lock timeouts. MySQL bounds pool checkout and client queries and
installs transaction execution and lock-wait limits. A deadline before enqueue
commit produces no durable message. After commit, timeout diagnostics retain
the message reference for later recovery.
JavaScript actor code that already runs is cooperative. The runtime does not
preempt it by force. If it outlives the caller's wait, leases and fenced commits
stay authoritative.

Each database adapter also tracks its active transaction through a platform
context store: `AsyncLocalStorage` in Node, and a turn-scoped store in the
browser that covers only synchronous code. A committed call or message wait
fails early when the same logical call stack already owns a Solid Objects
transaction. It fails before enqueue or polling. It does not wait for a
connection or a serialized SQLite slot that it cannot release. The SQLite WASM
adapter also captures each operation's absolute deadline at access entry, so
deadline enforcement does not depend on ambient context after an `await`.

PostgreSQL notifications are an opt-in latency layer. One event-driven client
per runtime listens on role-specific channels. It listens before the worker
checks durable state. This closes the listener-startup race, and no worker holds
a polling connection of its own. A notification advances a process-local role
generation
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
that bounded set. It does not return idle, because an idle return loses
parallelism across independent actor identities.

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

The browser hosts the same runtime through three layers. A platform seam
supplies what Node builtins supplied before: a context store, a host identity,
and UUID generation; `solid-objects/browser/host` registers the browser
implementations on import. A dedicated module worker owns the runtime and the
OPFS database, because OPFS sync access handles exist only in dedicated
workers. Across tabs, `solid-objects/browser/tab-host` elects one leader per
origin through the Web Locks API; only the leader opens the database and runs
workers, other tabs invoke through a versioned `BroadcastChannel` protocol
with idempotent request ids, and a dead leader's lock release promotes the
next candidate onto the same durable state.

`solid-objects/sync-bridge` connects a local runtime to a server runtime
through the existing effects outbox. An actor stages a sync intent in the same
transaction as its state change; the effect worker drains the outbox with
at-least-once delivery and retry backoff. Per-actor order comes from an
ordered drain up to the claimed effect's mailbox sequence, and the server
ingest deduplicates on the effect id through the normal idempotency-key path.

Solid Objects provides database-backed state coordination for Node.js and the
browser. It does not reproduce Cloudflare's placement or edge-runtime
guarantees.

# Architecture

Solid Objects is a database-backed virtual actor runtime. An actor is addressed
by `(actor type, actor id)`, processes one durable mailbox turn at a time, and
persists JSON state between activations.

A durable message envelope selects an actor `operation` and records its
`delivery_mode` as `async`, `sync`, or `internal`. An operation is actor code;
a message is the durable delivery record that invokes it.

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
boundaries.

Each runtime role occupies a supervised factory slot. An unexpected promise
resolution or rejection cleans up that instance, waits with capped exponential
backoff, and builds the replacement through the same factory. Supervision stops
at the shutdown boundary; database leases and fencing remain the correctness
mechanism if a failed role was still executing actor code.

A worker claims one actor globally, then preferentially drains up to
`maxMessagesPerActivationPass` ready turns for that instance. Reaching the cap
moves only that actor's already-due ready memberships to current database time.
Actors with older ready work therefore win the next global claim; delayed work
keeps its original future availability.

Realtime delivery is transport-neutral. A host-authenticated session authorizes
actor subscriptions, replays a committed observable projection, and follows
the durable broadcast outbox in revision order. The browser client applies the
same incarnation and revision fence without importing Node APIs.

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

This package ports the Solid Objects programming model. It does not share a
database schema or runtime protocol with the Ruby gem and does not reproduce
Cloudflare's placement or edge-runtime guarantees.

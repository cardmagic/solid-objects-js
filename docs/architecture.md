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

This package ports the Solid Objects programming model. It does not share a
database schema or runtime protocol with the Ruby gem and does not reproduce
Cloudflare's placement or edge-runtime guarantees.

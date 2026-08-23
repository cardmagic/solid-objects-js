# Choosing Solid Objects

Solid Objects is useful when an application has many independently addressed
entities and every entity needs ordered state changes, durable work, recovery,
or realtime projections.

## Use it when

- Concurrent requests can update the same room, cart, account, device,
  document, or session.
- Each identity needs its own ordering boundary and durable mailbox.
- Operations must recover after a Node process exits.
- State changes stage reminders, effects, actor-to-actor messages, or realtime
  invalidations atomically.
- The application already operates SQLite, PostgreSQL, or MySQL and should keep
  durable coordination there.
- A local-first application needs the same actor model in the browser:
  durable per-user state on SQLite WASM, one runtime shared across tabs, and
  an outbox that syncs to a server runtime when the network allows.

## Prefer a row transaction when

One short transaction with an update, constraint, or row lock completely
enforces the invariant. A direct transaction has less machinery, less stored
history, and no actor-state migration contract.

## Prefer another design when

- Work is a bulk or data-parallel pipeline rather than per-identity state.
- One global identity must sustain more writes than one sequential mailbox can
  commit.
- State is a large document or relational dataset that should be queried and
  updated in smaller normalized pieces.
- The application needs a transaction spanning several independent object
  identities.
- Compute and state must be automatically placed close to clients at the edge.
- The team wants a managed control plane to place, scale, and recover workers.
- Durable workflow replay across named steps is more important than a mutable
  object with ordered operations.

## Model identities deliberately

One hot identity is intentionally serialized. An identity should correspond to
the smallest domain boundary that requires one total order. Splitting a room by
player or a cart by item may improve parallelism, but it also gives up atomic
ordering across the split.

Different identities can run concurrently when worker capacity and the
database allow it. The [benchmark harness](benchmarks.md) measures both the hot
and independent-identity cases.

## Operational cost

The relational database stores actor instances, ready and claimed mailbox
membership, message history, leases, effects, reminders, broadcasts, dead
letters, and process records. Retention policies and the operator dashboard
make that state inspectable, but they do not remove the need to monitor and
back up the database.

Redis is optional. It is a transient notification path rather than durable
state, so losing Redis increases polling latency without losing committed work.

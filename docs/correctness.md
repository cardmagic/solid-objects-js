# Correctness and delivery semantics

## Guarantees

- Delivery is ordered per actor identity and at least once.
- Different identities may execute concurrently.
- Sequence allocation and durable enqueue are one transaction.
- A retryable failure rolls state and staged intents back and blocks later work.
- A stale activation may finish JavaScript but cannot commit.
- Effects can execute more than once and must deduplicate by their stable id.
- Destruction creates an incarnation boundary; old leases cannot address a
  recreated actor. A caller authorized before destruction receives
  `ActorDestroyed`; an unknown or forged reference remains unauthorized.
- Graceful process shutdown and stale-process cleanup use the same atomic
  ownership release. Claimed messages return to ready membership. The runtime
  unfences the activations. Effect, reminder, and broadcast claims become
  available again. A stale process that drains is recoverable like a stale
  process that runs.
- Permanent operation failure raises `MessageFailed`. The error carries the
  durable message ID and the persisted error details. Actor code text is not the
  public exception contract.
- Operation, lifecycle, observable, and payload callbacks retain their owning
  runtime through async context. Isolated runtimes therefore never fall back to
  a global default while actor-owned code resolves another actor reference.
- Observable outbox rows are claimed in actor revision order. Subscription
  sessions and browser clients reject duplicate or stale revisions within an
  incarnation, while a recreated actor starts a new revision sequence.
- Wake-up notifications happen only after commit and never replace polling.
  Workers watch before claiming, so an in-process notification between an empty
  claim and the following wait is retained.
- Activation passes are bounded. Yielding changes ready-membership polling
  order only; it neither changes durable message sequence nor makes future work
  due early.
- Idle hydrated actors keep the same renewable lease as their fence. Cache reuse
  never bypasses claim membership or the commit fence. A failed turn restores
  its public fields before reuse. Conditional release cannot clear a newer owner
  or generation.
- Actor setup completes before an attempt begins. A hydration, migration, or
  activation failure restores ready membership, releases its activation fence,
  and restores the attempt count. All three happen in one atomic step. A caller
  that waits receives the setup error.
- `guardApplicationDatabase()` rejects direct application writes during actor
  operations, observable and payload projections, and state migrations. It
  permits only `SELECT` through row-returning methods. Commit actions remain in
  that read-only context and may write only through their supplied fenced
  connection. The guarantee applies only to clients passed through the facade.
- Snapshots hydrate one committed state image and evaluate every inferred getter
  against it. Getter mutation or staged durable work rejects the whole snapshot;
  successful snapshots and their nested JSON values are frozen copies.
- Personalized payloads hydrate committed state separately for every payload
  name and subscriber. Each projection is read-only, size bounded, and fenced
  independently by actor incarnation and revision. One projection that is
  denied, that mutates, or that fails cannot stop its siblings or observable
  delivery. A state change on an actor with payloads creates a revision
  broadcast, even when that actor declares no scalar observables.

## Limitations and non-goals

- At-least-once execution means actor code may begin more than once. State and
  staged intents from a failed turn roll back, but arbitrary external work does
  not. External systems need stable idempotency keys.
- The activation fence protects the Solid Objects commit. It cannot revoke or
  undo network calls, files, emails, payments, or other external effects.
- One identity processes one write operation at a time. This is the ordering
  guarantee and also the hot-identity throughput limit.
- A commit is scoped to one actor turn. There is no transaction spanning two
  actor identities.
- Processes with incompatible `stateVersion` definitions cannot safely overlap.
  Once newer code persists a state version, older code rejects that actor.
- The application owns HTTP, WebSocket authentication, rendering, process
  placement, capacity, database backups, and database failover.
- Redis and PostgreSQL notifications reduce wake-up latency but do not replace
  durable polling or become a source of truth.
- `snapshotWithIncarnation`'s `createdAtMs` orders actor incarnations to the
  millisecond. Every adapter stores `created_at_ms` at that same precision. If
  you destroy and recreate the same actor identity inside one database-clock
  millisecond, the two incarnations get an equal `createdAtMs`. In that narrow
  case, a caller cannot tell which of the two is current, so it cannot fence a
  derived write on that value. `instanceId` still changes and shows that a
  recreation occurred. It is a random UUID and carries no order of its own.
- Large documents, bulk pipelines, globally placed edge state, and global
  counters are outside the intended workload. Prefer an ordinary row
  transaction when it completely enforces the invariant.

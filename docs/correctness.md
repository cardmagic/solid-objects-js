# Correctness and delivery semantics

- Delivery is ordered per actor identity and at least once.
- Different identities may execute concurrently.
- Sequence allocation and durable enqueue are one transaction.
- A retryable failure rolls state and staged intents back and blocks later work.
- A stale activation may finish JavaScript but cannot commit.
- Effects can execute more than once and must deduplicate by their stable id.
- Destruction creates an incarnation boundary; old leases cannot address a
  recreated actor. A caller authorized before destruction receives
  `ActorDestroyed`; an unknown or forged reference remains unauthorized.
- Permanent operation failure raises `MessageFailed` with the durable message
  ID and persisted error details instead of treating actor code text as the
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
- Idle hydrated actors remain fenced by the same renewable lease. Cache reuse
  never bypasses claim membership or the commit fence, failed turns restore
  their public fields before reuse, and conditional release cannot clear a
  newer owner or generation.
- `guardApplicationDatabase()` rejects direct application writes during actor
  operations, observable and payload projections, and state migrations. It
  permits only `SELECT` through row-returning methods; commit actions remain the
  fenced write path. The guarantee applies only to clients passed through the
  facade.
- Snapshots hydrate one committed state image and evaluate every inferred getter
  against it. Getter mutation or staged durable work rejects the whole snapshot;
  successful snapshots and their nested JSON values are frozen copies.
- Personalized payloads hydrate committed state separately for every payload
  name and subscriber. Each projection is read-only, size bounded, and fenced
  independently by actor incarnation and revision. One denied, mutating, or
  failing projection cannot stop its siblings or observable delivery. A state
  change on an actor declaring payloads creates a revision broadcast even when
  the actor declares no scalar observables.

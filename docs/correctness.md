# Correctness and delivery semantics

- Delivery is ordered per actor identity and at least once.
- Different identities may execute concurrently.
- Sequence allocation and durable enqueue are one transaction.
- A retryable failure rolls state and staged intents back and blocks later work.
- A stale activation may finish JavaScript but cannot commit.
- Effects can execute more than once and must deduplicate by their stable id.
- Destruction creates an incarnation boundary; old leases cannot address a
  recreated actor.
- Observable outbox rows are claimed in actor revision order. Subscription
  sessions and browser clients reject duplicate or stale revisions within an
  incarnation, while a recreated actor starts a new revision sequence.
- Wake-up notifications happen only after commit and never replace polling.
  Workers watch before claiming, so an in-process notification between an empty
  claim and the following wait is retained.

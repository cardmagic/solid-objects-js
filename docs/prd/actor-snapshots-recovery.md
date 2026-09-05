# PRD: actor snapshots and recovery

Status: Proposed · Owner: Solid Objects maintainers · Issue: [#38](https://github.com/cardmagic/solid-objects-js/issues/38)

## Problem and users

Operators need a portable way to back up, inspect, restore, or fork committed
actor state. Provider-native point-in-time recovery is useful but cannot be
assumed by every adapter. Users are operators recovering incidents and teams
testing migrations without mutating production actors.

## Outcome and success measures

An authorized operator can create a consistent actor checkpoint and restore or
fork it with an auditable revision boundary. Success is measured by successful
restore drills, zero partial snapshots, and a documented recovery point and
recovery time objective for each adapter.

## Non-goals

- A fleet backup service or cross-actor snapshot transaction.
- Restoring arbitrary provider-internal tables.
- Hiding incompatible application state migrations.

## Requirements

- SNAP-001: A snapshot shall represent one committed actor state, revision,
  incarnation, schema version, and creation time.
- SNAP-002: Snapshot creation shall be consistent with actor turns and shall
  never include half-committed state or in-flight mailbox claims.
- SNAP-003: The API shall support listing and deleting snapshots subject to
  authorization and retention policy.
- SNAP-004: Restore shall require an explicit target actor and confirmation
  token or equivalent idempotency guard.
- SNAP-005: Restore shall either replace an actor at a new incarnation or create
  a fork; it shall never silently merge divergent state.
- SNAP-006: Incompatible state versions shall fail before any target mutation
  and return an actionable migration error.
- SNAP-007: Snapshot and restore operations shall be observable and resumable
  after transient adapter failure.
- SNAP-008: Adapters may map the API to PITR, serialized state, or database
  backups, but all must expose the same consistency and authorization contract.

## Acceptance criteria

- Tests prove snapshots exclude in-flight turns and restore exact committed
  state, revision, and schema metadata.
- A failed restore leaves the target unchanged and can be retried safely.
- A fork receives a new identity/incarnation and does not share mutable storage.
- Documentation states retention, size limits, encryption, and RPO/RTO per adapter.

## Risks and rollout

Start with export and restore to a new actor identity; defer destructive
in-place restore until operational tooling and backup verification exist.

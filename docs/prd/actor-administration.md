# PRD: portable actor administration

Status: Proposed · Owner: Solid Objects maintainers · Issue: [#41](https://github.com/cardmagic/solid-objects-js/issues/41)

## Problem and users

Operators can inspect and repair actors only through adapter-specific tooling.
Users are on-call engineers and application administrators who need safe,
audited per-actor operations.

## Outcome and success measures

Every adapter offers the same authorized per-actor inspection and repair
workflow. Success means an operator can diagnose a stuck actor, retry a dead
letter, or resume a paused reminder without direct database access.

## Non-goals

- Fleet-wide operations where an adapter cannot provide a consistent index.
- Bypassing application authorization.
- Silent mutation of actor state.

## Requirements

- ADMIN-001: The API shall expose mailbox depth, oldest pending message, active
  claims, incarnation, revision, and last activation information.
- ADMIN-002: The API shall list dead letters and include operation, arguments
  metadata, attempts, failure, and timestamps without exposing secrets.
- ADMIN-003: Retrying a dead letter shall be idempotent and shall create a new
  auditable delivery attempt.
- ADMIN-004: The API shall inspect reminders and support resuming paused
  reminders with an optional run time.
- ADMIN-005: The API shall expose outbox status and age sufficient to diagnose
  effect, callback, and broadcast backpressure.
- ADMIN-006: Every mutating administration operation shall require explicit
  authorization and emit an audit event.
- ADMIN-007: Reads shall not mutate actor state; repairs shall preserve mailbox
  ordering and idempotency guarantees.
- ADMIN-008: Fleet-level operations shall be capability-gated and must not be
  simulated by unbounded per-actor scans.

## Acceptance criteria

- Tests cover authorization, idempotent retry, reminder resume, mailbox
  inspection, outbox inspection, audit events, and concurrent repair attempts.
- An operator can diagnose and repair a failed actor using only the public API.
- Secrets and arbitrary payload contents are redacted according to documented
  rules.

## Risks and rollout

Stabilize read-only inspection first. Add retry and resume operations only after
audit events and authorization hooks are available in every adapter.

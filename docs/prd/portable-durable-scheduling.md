# PRD: portable durable scheduling

Status: Proposed · Owner: Solid Objects maintainers · Issue: [#37](https://github.com/cardmagic/solid-objects-js/issues/37)

## Problem and users

Actor authors need work to happen after a delay or on a recurring cadence even
when no request is active. Today each adapter exposes different scheduling
primitives and edge cases. Users are application developers building expiry,
renewal, retry, and maintenance workflows.

## Outcome and success measures

An actor author can schedule, inspect, reschedule, and cancel durable work
without knowing whether the adapter uses alarms, a scheduler process, or a
database. Success means every production adapter passes the same conformance
suite for idempotency, missed runs, cancellation, and recovery; scheduled work
has no silent loss and exposes its current status.

## Non-goals

- Exposing provider-specific alarm APIs.
- Guaranteeing exactly-once execution; delivery remains at least once.
- Replacing general-purpose queues or cron systems.

## Requirements

- SCHED-001: The API shall create a named schedule owned by one actor with an
  operation, JSON arguments, and a first-run time.
- SCHED-002: A name shall identify at most one active schedule per actor;
  rescheduling shall replace its next occurrence atomically.
- SCHED-003: The API shall cancel a schedule idempotently and report whether a
  schedule was removed.
- SCHED-004: The API shall support one-shot and recurring schedules with an
  explicit interval or recurrence policy.
- SCHED-005: The API shall define missed-run policies (`run_once`, `skip`, or
  `catch_up`) and persist the selected policy.
- SCHED-006: Schedule execution shall use the normal actor mailbox, authorization,
  retry, dead-letter, and idempotency semantics.
- SCHED-007: Inspection shall return status, next run, last run, attempt, and
  failure information without mutating actor state.
- SCHED-008: Adapter implementations shall recover scheduled work after
  process, object, or host restart.

## Acceptance criteria

- Conformance tests cover create, replace, cancel, recurring execution, each
  missed-run policy, restart recovery, authorization failure, and duplicate
  delivery.
- A schedule can never execute after a successful cancellation that preceded
  its claim.
- Documentation includes time-zone, clock-skew, retention, and retry behavior.

## Risks and rollout

The first release should extend reminders rather than add a second scheduler
model. Ship behind the capability flag, migrate one adapter at a time, and
publish timing guarantees before enabling recurring schedules by default.

# PRD: portable observability and diagnostics

Status: Proposed · Owner: Solid Objects maintainers · Issue: [#42](https://github.com/cardmagic/solid-objects-js/issues/42)

## Problem and users

The same actor workload produces different operational signals depending on the
backend. Users are developers, operators, and support engineers who need to
compare latency, backlog, retries, and recovery behavior without learning each
provider’s telemetry system.

## Outcome and success measures

Solid Objects emits a small, stable set of structured events and metrics with
consistent meanings. Success means an operator can identify latency, backlog,
failure, and recovery regressions from adapter-neutral telemetry and correlate
an event to an actor, message, revision, and attempt.

## Non-goals

- Shipping a hosted metrics or tracing product.
- Prescribing a vendor, exporter, or dashboard.
- Logging sensitive arguments or state by default.

## Requirements

- OBS-001: Events shall cover activation start/completion/failure, message
  retry/dead-letter, mailbox depth, reminder lateness, outbox age, recovery,
  snapshot, and realtime session changes.
- OBS-002: Each event shall include timestamp, actor identity, incarnation,
  revision or message ID when applicable, attempt, and adapter name.
- OBS-003: Metrics shall define units, aggregation, cardinality guidance, and
  whether values are gauges, counters, or histograms.
- OBS-004: Instrumentation shall support structured logging, metrics, and
  tracing hooks without requiring a provider SDK.
- OBS-005: Diagnostics shall expose bounded, authorization-aware summaries for
  mailbox, outbox, reminders, retries, and recovery failures.
- OBS-006: Default telemetry shall exclude arguments, actor state, credentials,
  and unredacted provider responses.
- OBS-007: Adapters shall map native telemetry to the common schema without
  changing event meaning or delivery semantics.
- OBS-008: Instrumentation failure shall never fail an actor turn or alter its
  committed result.

## Acceptance criteria

- Tests verify representative success, retry, failure, dead-letter, recovery,
  reminder, outbox, and realtime events.
- A documented dashboard/query example works with emitted events from two
  adapters.
- Redaction and cardinality rules are tested, and instrumentation failures are
  isolated from application behavior.

## Risks and rollout

Begin with event names and field definitions, then add exporters. Keep the
existing logger hook compatible and make new metrics opt-in until cardinality
has been measured in production.

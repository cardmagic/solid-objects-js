# Changelog

## Unreleased

- Add deny-by-default dead-letter inspection and idempotent durable retry.
- Add sequential schema migrations and upgrade version-one SQLite databases.
- Add bounded, authorization-gated reconciliation reads for actor lifecycle
  repair.
- Add previewable bounded retention for messages, stopped processes, and
  opt-in actor instances.
- Add structured installation diagnostics and a targeted durable round trip.
- Add deterministic runtime draining and explicit database reset helpers for
  tests.
- Add isolated structured lifecycle instrumentation with metadata-only events.
- Add reminder replacement events and authorized inspection and resume APIs.
- Add deny-by-default transport-neutral realtime subscriptions with committed
  replay and revision fencing.
- Add injectable generation-based wake-up signals with a process-local default.
- Add supervised role replacement through original factories with capped
  restart backoff.
- Add authorized process inspection and atomic stale-owner cleanup.
- Add a JSON CLI for runtime startup, diagnostics, administration, and explicit
  retention pruning.
- Add bounded multi-turn activation passes with database-ordered hot-actor
  fairness.
- Add an opt-in application-database facade that rejects direct writes during
  actor execution while keeping registered commit actions writable.
- Add typed subscriber-specific realtime payloads with query authorization,
  committed-state projection, failure isolation, and independent revision
  fencing.
- Add PostgreSQL 14+ through the optional `pg` driver with pooled transactions,
  row-locked sequence allocation, portable schema and set queries, diagnostics,
  and real-server integration coverage.
- Add opt-in role-specific PostgreSQL wake-ups with one event-driven listener
  per runtime and polling as the correctness fallback.
- Add a typed browser component registry with keyed dependencies, replace/morph
  strategies, batch coalescing, cancellation, and per-target revision fencing.
- Add Chromium QA for native WebSocket subscription replay, realtime fences,
  personalized payloads, component batching, and request cancellation.

## 0.1.0 - 2026-08-13

- Add ordinary TypeScript actor classes with inferred, typed references.
- Add committed calls, asynchronous sends, actor-to-actor delivery, reminders,
  effects, commit actions, snapshots, destruction, and explicit observables.
- Add a SQLite durable mailbox with ordered turns, idempotency, retries, leases,
  fencing, dead letters, process heartbeats, and stale-claim recovery.
- Add supervised workers for actor turns, effects, reminders, and broadcasts.
- Add a Node-free browser client for versioned observable invalidations.
- Deny public actor operations and destruction by default, and reauthorize
  durable message status, result, and wait reads.
- Use options objects for library APIs with more than two inputs and enforce the
  convention during type checking.
- Name invoked actor methods `operation` throughout the API and persistence,
  and name message submission semantics `delivery_mode`.
- Publish SQLite as the only database adapter supported by the initial release.

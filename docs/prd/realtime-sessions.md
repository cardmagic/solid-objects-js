# PRD: portable realtime sessions

Status: Proposed · Owner: Solid Objects maintainers · Issue: [#40](https://github.com/cardmagic/solid-objects-js/issues/40)

## Problem and users

Applications need committed actor changes delivered to browsers and services,
but transports differ across adapters. Users are application developers
building dashboards, collaborative interfaces, and live projections.

## Outcome and success measures

One session contract defines authorization, subscription, replay, expiry, and
delivery behavior. Adapters may use WebSockets, SSE, or another transport.
Success means reconnecting clients converge to the latest committed projection
and conformance tests pass without depending on a specific transport.

## Non-goals

- A universal transport or UI client.
- Exactly-once network delivery.
- Broadcasting uncommitted actor state.

## Requirements

- REAL-001: A session shall be created with an authenticated identity and an
  explicit expiry.
- REAL-002: Subscribe and unsubscribe shall be idempotent and authorized for
  each actor and payload projection.
- REAL-003: The first subscription and every reconnect shall provide a committed
  projection before or with subsequent invalidations.
- REAL-004: Events shall identify actor identity, incarnation, and revision so
  clients can detect stale or out-of-order delivery.
- REAL-005: A session shall close or reauthorize when its authorization expires
  or is revoked.
- REAL-006: Backpressure shall be bounded; the API shall define whether events
  are queued, coalesced, or cause a reconnect.
- REAL-007: Adapter transports shall preserve the session semantics while
  keeping wire framing and connection lifecycle private to the adapter.
- REAL-008: Delivery shall be at least once and clients shall receive enough
  metadata to deduplicate or refresh projections safely.

## Acceptance criteria

- Tests cover initial replay, reconnect, expiry, revocation, duplicate events,
  stale revisions, unauthorized subscriptions, and backpressure.
- A reference client works against two transports or one transport plus a
  deterministic in-memory conformance adapter.
- Documentation distinguishes committed projection replay from invalidation
  delivery.

## Risks and rollout

Keep the existing browser protocol as one implementation. Introduce the
backend-neutral contract first, then add alternate transports only after the
semantics are stable.

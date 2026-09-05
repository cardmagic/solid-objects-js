# Roadmap

These are backend-neutral capabilities that should remain useful across SQL,
browser, and Cloudflare Durable Objects adapters. Provider-specific primitives
should stay behind each adapter rather than becoming part of the public API.

## Portable durable scheduling

Expand reminders into a complete durable scheduling abstraction with
cancellation, rescheduling, recurring schedules, missed-run policies, status
inspection, and next-run inspection while preserving idempotent,
at-least-once delivery.

[Issue #37: portable durable scheduling](https://github.com/cardmagic/solid-objects-js/issues/37)

## Portable actor snapshots and recovery

Add committed actor checkpoints with revision metadata, authorization,
retention, restore, and fork semantics. Provider-specific point-in-time
recovery can remain an adapter implementation detail.

[Issue #38: portable actor snapshots and recovery](https://github.com/cardmagic/solid-objects-js/issues/38)

## Feature-level capability negotiation

Replace coarse capability flags with a versioned feature-level contract for
scheduling, snapshots, transactions, realtime, administration, recovery, and
diagnostics. Unsupported operations should remain fail-fast and actionable.

[Issue #39: feature-level capability negotiation](https://github.com/cardmagic/solid-objects-js/issues/39)

## Portable realtime sessions

Standardize session creation, expiry, reconnect, subscription, projection
replay, authorization, and backpressure independently of the transport. A
backend may use WebSockets, SSE, or another transport behind the adapter.

[Issue #40: portable realtime sessions](https://github.com/cardmagic/solid-objects-js/issues/40)

## Portable actor administration

Standardize per-actor inspection and operations for mailbox state, dead
letters, reminders, outboxes, incarnation, and revision. Fleet-wide operations
remain optional where a backend cannot provide them.

[Issue #41: portable actor administration](https://github.com/cardmagic/solid-objects-js/issues/41)

## Portable observability and diagnostics

Define common structured events, metrics, and diagnostic views for activation
duration, mailbox depth, retries, dead letters, reminder lateness, outbox age,
recovery failures, and realtime subscriptions without leaking provider APIs.

[Issue #42: portable observability and diagnostics](https://github.com/cardmagic/solid-objects-js/issues/42)

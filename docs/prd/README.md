# Backend portability PRDs

These PRDs define the six backend-neutral capabilities on the Solid Objects
roadmap. They follow a consistent structure: problem, users, outcomes,
requirements, acceptance criteria, risks, and rollout. Requirements use
observable behavior so they can be implemented and verified independently.

The documents are intentionally product-level. Adapter-specific design belongs
in implementation plans after the API and semantics are agreed.

- [Portable durable scheduling](./portable-durable-scheduling.md) · [Issue #37](https://github.com/cardmagic/solid-objects-js/issues/37)
- [Actor snapshots and recovery](./actor-snapshots-recovery.md) · [Issue #38](https://github.com/cardmagic/solid-objects-js/issues/38)
- [Feature-level capability negotiation](./capability-negotiation.md) · [Issue #39](https://github.com/cardmagic/solid-objects-js/issues/39)
- [Portable realtime sessions](./realtime-sessions.md) · [Issue #40](https://github.com/cardmagic/solid-objects-js/issues/40)
- [Portable actor administration](./actor-administration.md) · [Issue #41](https://github.com/cardmagic/solid-objects-js/issues/41)
- [Portable observability and diagnostics](./observability-diagnostics.md) · [Issue #42](https://github.com/cardmagic/solid-objects-js/issues/42)

## PRD standard

Every PRD must state its target users, measurable outcomes, explicit
non-goals, authorization and failure semantics, compatibility expectations,
and testable acceptance criteria. No document promises a provider primitive
that another adapter cannot represent.

# PRD: feature-level capability negotiation

Status: Proposed · Owner: Solid Objects maintainers · Issue: [#39](https://github.com/cardmagic/solid-objects-js/issues/39)

## Problem and users

Applications currently discover backend differences through coarse flags or
runtime exceptions. Users are library authors and application developers who
need portable code with deliberate fallbacks.

## Outcome and success measures

Every runtime reports a stable, versioned capability document. Applications can
choose a supported path before issuing an operation, while unsupported calls
remain fail-fast. Success means no adapter-specific feature is undocumented and
the conformance suite validates the same capability shape everywhere.

## Non-goals

- Making all adapters implement every feature.
- Exposing infrastructure limits as an unstable public API.
- Replacing authorization checks or runtime error handling.

## Requirements

- CAP-001: The runtime shall expose a versioned capability document with
  feature name, support level (`supported`, `partial`, `unsupported`), and
  semantic notes.
- CAP-002: Features shall include scheduling, snapshots, cross-actor
  transactions, realtime sessions, administration, recovery, diagnostics, and
  local storage queries.
- CAP-003: Partial support shall identify operation-level gaps and relevant
  limits, not merely return `true`.
- CAP-004: Capability inspection shall be side-effect free and available before
  actor invocation.
- CAP-005: Unsupported operations shall raise `UnsupportedCapability` with the
  feature name and a supported alternative when one exists.
- CAP-006: Capability names and compatibility rules shall be documented and
  versioned without exposing provider names in application logic.

## Acceptance criteria

- Each adapter returns schema-valid capability data.
- Tests verify supported, partial, and unsupported behavior, including an
  operation that is rejected before provider I/O.
- A compatibility guide shows how to implement fallbacks for every partial
  feature.

## Risks and rollout

Add the detailed document alongside existing flags first. Deprecate ambiguous
booleans only after one release with migration documentation.

# Contributing

Solid Objects changes can affect durable state and recovery. A contribution
should explain the invariant it changes and include a regression test at the
lowest layer that can prove it.

## Setup

Install Node.js 24.15 or newer, enable Corepack, and install the locked
dependencies. The package supports Node.js 24.4.0 or newer and CI runs the
default suite, the build, and the recovery demo on that floor, but 24.15 is
where `node:sqlite` stops printing an experimental warning:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Validation

Run the local quality gates before opening a pull request:

```bash
pnpm run format:check
pnpm run check
pnpm run test:coverage
pnpm run build
pnpm run pack:check
pnpm run test:package
pnpm run test:recovery
```

Run `pnpm run test:browser` after installing Playwright Chromium. The database
and wake-up suites use these variables:

- `SOLID_OBJECTS_DATABASE_URL` for PostgreSQL or MySQL integration tests;
- `SOLID_OBJECTS_REDIS_URL` for the optional Redis wake-up suite.

Use disposable databases. Do not include credentials, production data,
customer identifiers, or other personal information in fixtures or reports.

## Correctness changes

For mailbox, lease, fencing, retry, effect, reminder, or migration changes,
include the failure sequence the test exercises. Prefer deterministic clocks,
explicit process coordination, and durable assertions over sleeps or mock-only
proof. Update [Correctness and delivery semantics](docs/correctness.md) when a
guarantee or limitation changes.

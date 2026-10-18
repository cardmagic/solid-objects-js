# Maintenance and continuity

This page tells you who maintains Solid Objects, how a release is made, and
what you keep if maintenance stops. It also tells you how to help maintain the
project.

## Who maintains it

Lucas Carlson ([@cardmagic](https://github.com/cardmagic)) is the lead
maintainer of the npm package `solid-objects` and of the Ruby gem
[`solid_objects`](https://github.com/cardmagic/solid-objects-ruby). The two
packages use the same model and the same correctness contract. A change to the
model goes into both packages, and the [parity ledger](parity.md) records each
difference between them.

The same maintainer sells [Solid Objects Pro](https://solidobjects.pro), a
commercial package that batches operations at scale. Pro depends on this
package. This package does not depend on Pro, and it needs no account, license
key, or service from the maintainer.

## How a change is checked

CI runs on each push and each pull request:

- Types, formatting, documentation links, the unit tests with coverage, and
  the packaged artifact.
- The suite on the oldest supported Node.js version.
- The database suites on PostgreSQL and MySQL, and the Redis wake-up suite.
- The browser runtime in Chromium.

[Supported versions](support.md) lists the CI matrix. The
[correctness contract](correctness.md) lists the guarantees that the tests
check.

## How a release is made

1. The maintainer pushes a version tag, for example `v1.0.3`.
2. GitHub Actions runs all test jobs again on that tag.
3. If all test jobs pass, GitHub Actions publishes the package to npm with
   trusted publishing. The repository keeps no npm token, and npm shows a
   provenance attestation for each version.
4. The same job makes a GitHub release from the changelog.

[Releasing](releasing.md) gives the full procedure. [Versioning](versioning.md)
tells you what a release can change. [CHANGELOG.md](../CHANGELOG.md) lists each
release.

## What you keep if maintenance stops

- **Your data.** With the SQL runtime, actor state, mailboxes, reminders, and
  effects are rows in your application's database. No service of the
  maintainer holds your data.
- **The code.** The [MIT License](../MIT-LICENSE) lets anyone use, change,
  fork, and publish the code.
- **The checks.** The tests and the CI configuration are in this repository. A
  fork can check its changes with the same suite.

## Help maintain Solid Objects

The project wants more maintainers. Experience with TypeScript and Node.js,
with locks and transactions in PostgreSQL or MySQL, or with Rails helps.

1. Read [CONTRIBUTING.md](../CONTRIBUTING.md).
2. Send a small pull request: a fix, a test, or a correction to a guide.
3. After some of your pull requests are merged, open an
   [issue](https://github.com/cardmagic/solid-objects-js/issues) to ask to
   become a maintainer.

To report a vulnerability, use the private process in
[SECURITY.md](../SECURITY.md).

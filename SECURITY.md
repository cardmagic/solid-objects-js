# Security policy

## Private reports

Report vulnerabilities through GitHub's
[private vulnerability reporting](https://github.com/cardmagic/solid-objects-js/security/advisories/new).
Do not open a public issue for a vulnerability that could expose data, bypass
authorization, corrupt durable state, or help an attacker.

Include the affected package version, adapter, deployment shape, impact, and a
minimal reproduction using synthetic data. Never include credentials, database
dumps, access tokens, or real application data.

## Correctness and data-safety reports

A non-sensitive correctness bug may use a
[GitHub issue](https://github.com/cardmagic/solid-objects-js/issues). Describe
the expected invariant, the observed state transition, process or retry
sequence, and database adapter. If the report reveals an exploitable condition
or private data, use private vulnerability reporting instead.

Only the latest released version receives fixes. Older releases may be useful
for reproducing a regression, but users should verify the fix on the latest
release.

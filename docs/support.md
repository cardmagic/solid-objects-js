# Supported versions and test matrix

## Runtime support

| Component      | Supported or tested range                                   |
| -------------- | ----------------------------------------------------------- |
| Node.js        | 24.4.0 or newer; CI runs 24.4.0 and 24.15.0                 |
| TypeScript     | 5.9 or newer for TypeScript applications                    |
| SQLite         | Node's built-in `node:sqlite` on the supported Node runtime |
| PostgreSQL     | 14 or newer; CI runs 14 and 18                              |
| MySQL          | 8.0 or newer with InnoDB; CI runs 8.0 and 8.4               |
| Redis wake-up  | Optional; CI runs Redis 7                                   |
| Browser client | Chromium through Playwright                                 |

The package is ESM-only. PostgreSQL, MySQL, and Redis require their optional
peer dependency. SQLite has no driver dependency beyond Node.js.

The Node.js floor is 24.4.0 because the SQLite adapter reads integer columns as
`BigInt`. Node.js 24.4.0 is the first release that accepts `readBigInts` on the
`DatabaseSync` constructor. Node.js 24.0.0 through 24.3.x ignore the option and
return `Number`, which loses precision on 64-bit values and fails the effect
recovery and transaction retry tests.

Node.js 24.15.0 is the first release where `node:sqlite` is no longer
experimental. Between 24.4.0 and 24.14.x the module works but prints
`ExperimentalWarning: SQLite is an experimental feature` on stderr, and its API
can change. Prefer 24.15.0 or newer where the choice is free.

## What the matrix covers

The default suite exercises actor definitions, mailbox ordering, state
migrations, leases, fencing, retries, dead letters, effects, reminders,
realtime outboxes, administration, authorization, retention, lifecycle,
timeouts, and SQLite behavior.

Database jobs run the real adapter suites against PostgreSQL and MySQL servers.
The Redis job runs wake-up behavior against a real Redis server. The browser
job uses native WebSocket connections and Chromium for replay, payload,
component, dashboard, and revision-fence behavior.

The quality job also builds the ESM package, inspects `npm pack`, installs the
generated tarball in a clean temporary project, runs its packaged SQLite
quickstart, and executes the multi-process recovery demonstration.

## Boundaries

CI currently runs on Ubuntu. Local validation also occurs on macOS, but the
project does not claim a complete operating-system compatibility matrix. A
database version being accepted by configuration is not a substitute for its
listed integration job.

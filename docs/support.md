# Supported versions and test matrix

## Runtime support

| Component      | Supported or tested range                                   |
| -------------- | ----------------------------------------------------------- |
| Node.js        | 24.15 or newer; CI uses 24.15                               |
| TypeScript     | 5.9 or newer for TypeScript applications                    |
| SQLite         | Node's built-in `node:sqlite` on the supported Node runtime |
| PostgreSQL     | 14 or newer; CI runs 14 and 18                              |
| MySQL          | 8.0 or newer with InnoDB; CI runs 8.0 and 8.4               |
| Redis wake-up  | Optional; CI runs Redis 7                                   |
| Browser client | Chromium through Playwright                                 |

The package is ESM-only. PostgreSQL, MySQL, and Redis require their optional
peer dependency. SQLite has no driver dependency beyond Node.js.

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

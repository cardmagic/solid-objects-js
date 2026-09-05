# Supported versions and test matrix

## Runtime support

| Component          | Supported or tested range                                          |
| ------------------ | ------------------------------------------------------------------ |
| Node.js            | 24.4.0 or newer; CI runs 24.4.0 and 24.15.0                        |
| TypeScript         | 5.9 or newer for TypeScript applications                           |
| SQLite             | Node's built-in `node:sqlite` on the supported Node runtime        |
| PostgreSQL         | 14 or newer; CI runs 14 and 18                                     |
| MySQL              | 8.0 or newer with InnoDB; CI runs 8.0 and 8.4                      |
| Redis wake-up      | Optional; CI runs Redis 7                                          |
| Browser client     | Chromium through Playwright                                        |
| SQLite WASM        | `@sqlite.org/sqlite-wasm` 3.50 or newer; optional                  |
| Browser runtime    | Chromium through Playwright; OPFS for persistent storage           |
| Cloudflare runtime | Experimental; Workers integration tests and Wrangler bundle checks |

The package is ESM-only. PostgreSQL, MySQL, Redis, and SQLite WASM require
their optional peer dependency. The Node SQLite adapter has no driver
dependency beyond Node.js.

The browser runtime is tested in Chromium. The APIs it needs are standard,
so other engines work where those APIs exist; verify them on the exact
engine you target:

- Persistent storage needs OPFS sync access handles in a dedicated worker.
  Chromium has them; Safari added them in 16.4; Firefox added them in 111.
- The multi-tab hosts need the Web Locks API and `BroadcastChannel`, which
  every current engine provides.
- An embedded WebView is not the platform browser. Cordova and other
  WKWebView or Android WebView shells can lack OPFS even when the device's
  browser has it. `sqliteWasm({ storage: "persistent" })` fails fast where
  OPFS is missing, and temporary storage still works wherever the WASM
  module loads, so probe the target WebView before you commit to durable
  in-app state.

The browser runtime needs two platform capabilities:

- Persistent storage uses the OPFS SAH pool VFS, which needs a secure context
  and a dedicated worker. `sqliteWasm({ storage: "persistent" })` fails fast
  where OPFS is unavailable; temporary storage works everywhere the WASM
  module loads.
- The tab host election uses the Web Locks API. Every current browser
  provides it. Node.js provides `navigator.locks` from 24.5, so Node-side use
  of `solid-objects/browser/tab-host` needs a newer Node than the package
  floor; the tab host test suite skips on older Node.

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

The default suite exercises:

- actor definitions, mailbox order, and state migrations;
- leases, fencing, retries, and dead letters;
- effects, reminders, and realtime outboxes;
- administration, authorization, and retention;
- lifecycle, timeouts, and SQLite behavior.

Database jobs run the real adapter suites against PostgreSQL and MySQL servers.
The Redis job runs wake-up behavior against a real Redis server. The browser
job uses native WebSocket connections and Chromium for replay, payload,
component, dashboard, and revision-fence behavior. It also runs the browser
runtime suites in Chromium module workers: SQLite WASM transactions and OPFS
persistence across page reloads, the full runtime with durable actor state,
deadline rollback under the turn-scoped context store, two tabs on one
runtime with leader failover, and the sync bridge drain into a Node runtime.

The quality job also:

1. builds the ESM package;
2. inspects `npm pack`;
3. installs the tarball in a clean temporary project;
4. runs the packaged SQLite quickstart;
5. executes the multi-process recovery demonstration.

## Boundaries

CI currently runs on Ubuntu. Local validation also occurs on macOS, but the
project does not claim a complete operating-system compatibility matrix. A
database version being accepted by configuration is not a substitute for its
listed integration job.

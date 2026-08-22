# Configuration reference

`configure(options)` creates a runtime and installs it as the default used by
`Actor.ref()`. `createRuntime(options)` creates an isolated runtime addressed
through `runtime.ref(ActorClass, actorId)`. Both validate options immediately.

## Core runtime options

| Option                                |                  Default | Contract                                                                      |
| ------------------------------------- | -----------------------: | ----------------------------------------------------------------------------- |
| `database`                            |                 required | A `Database` adapter.                                                         |
| `tableNamePrefix`                     |       `"solid_objects_"` | Lowercase letters, digits, and underscores; must start with a letter.         |
| `pollingIntervalMilliseconds`         |                    `100` | Positive durable-work polling interval.                                       |
| `idlePollingIntervalMilliseconds`     |                  `1_000` | Positive ceiling after consecutive empty polling passes.                      |
| `syncPollingIntervalMilliseconds`     |                     `50` | Positive result-wait polling interval.                                        |
| `leaseDurationMilliseconds`           |                 `30_000` | Positive activation lease; must exceed renewal interval.                      |
| `leaseRenewalIntervalMilliseconds`    |                 `10_000` | Positive activation renewal cadence.                                          |
| `idleDeactivationTimeoutMilliseconds` |                 `30_000` | Non-negative hydrated activation cache lifetime; `0` disables idle retention. |
| `maxMailboxLength`                    |                 `10_000` | Positive maximum ready and claimed messages for one actor.                    |
| `maxPayloadBytes`                     |              `1_048_576` | Positive byte limit for operation arguments and personalized payloads.        |
| `maxStateBytes`                       |              `5_242_880` | Positive persisted actor-state byte limit.                                    |
| `maxResultBytes`                      |              `1_048_576` | Positive operation-result byte limit.                                         |
| `maxAttempts`                         |                      `5` | Positive maximum operation, effect, and broadcast attempts.                   |
| `maxMessagesPerActivationPass`        |                     `50` | Positive integer turn budget before fairness yield.                           |
| `maxActivationDurationMilliseconds`   |                  `5_000` | Positive elapsed-time budget before fairness yield.                           |
| `claimScanLimit`                      |                    `100` | Positive integer ready-actor candidates considered per global claim.          |
| `retryDelayMilliseconds`              | exponential 1-60 seconds | Receives the next attempt number and returns its delay.                       |

The limits measure normalized JSON encoded as UTF-8. `maxResultBytes` also
limits each computed snapshot getter and effect-handler result. Explicit
`observables()` values are validated as JSON but do not currently have a
separate aggregate byte limit. This includes values wrapped in
`broadcastInvalidation()`: they are compared in memory even though only their
names enter the broadcast outbox. `retryDelayMilliseconds` should return a
non-negative finite number; an invalid application callback will fail the
affected failure path rather than schedule an invalid timestamp.

## Runtime roles and supervision

| Option                                      |                  Default | Contract                                                 |
| ------------------------------------------- | -----------------------: | -------------------------------------------------------- |
| `workerCount`                               |                      `1` | Non-negative actor workers.                              |
| `effectWorkerCount`                         |                      `1` | Non-negative effect workers.                             |
| `broadcastWorkerCount`                      |                      `1` | Non-negative broadcast workers when realtime is enabled. |
| `reminderSchedulerCount`                    |                      `1` | Non-negative reminder schedulers.                        |
| `processHeartbeatIntervalMilliseconds`      |                 `15_000` | Positive persisted heartbeat cadence.                    |
| `processAliveThresholdMilliseconds`         |                 `60_000` | Positive age after which an owner is stale.              |
| `shutdownTimeoutMilliseconds`               |                 `15_000` | Positive shared graceful-shutdown budget.                |
| `supervisorRestartDelayMilliseconds`        |                    `100` | Positive initial failed-role replacement delay.          |
| `supervisorMaximumRestartDelayMilliseconds` |                 `10_000` | Positive cap no smaller than the initial delay.          |
| `wakeUp`                                    | `InProcessWakeUpAdapter` | Adapter implementing `watch`, `notify`, and `close`.     |
| `logger`                                    |          console methods | Structured `debug`, `info`, `warn`, and `error` sink.    |

Counts may be zero, but the complete configuration must leave at least one
runtime role enabled. Broadcast workers are started only when `broadcast` or
`authorizeSubscription` is configured.

`pollingIntervalMilliseconds` is the fast interval after work or a wake-up.
Consecutive empty passes double it up to
`idlePollingIntervalMilliseconds`. Actor workers never wait longer than
`leaseRenewalIntervalMilliseconds`. Set the fast and idle values equal for a
fixed cadence. A custom wake-up adapter must return `true` for a notification
and `false` for a timeout. An older adapter that returns `void` remains
compatible and keeps the fast cadence. Wake-ups reduce latency, while database
polling remains the correctness path.

## Retention and cleanup

| Option                                   |     Default | Contract                                                         |
| ---------------------------------------- | ----------: | ---------------------------------------------------------------- |
| `retentionIntervalMilliseconds`          | `3_600_000` | Non-negative automatic history-pruning cadence; `0` disables it. |
| `deadProcessCleanupIntervalMilliseconds` |    `60_000` | Non-negative stale-owner recovery cadence; `0` disables it.      |
| `messageRetentionMilliseconds`           |     30 days | Positive default completed-message retention.                    |
| `messageRetentionByActorType`            |        `{}` | Positive per-type message-retention overrides.                   |
| `instanceRetentionByActorType`           |        `{}` | Positive per-type instance-expiration opt-ins.                   |
| `processRetentionMilliseconds`           |      7 days | Positive stopped-process retention.                              |
| `pruneBatchSize`                         |     `1_000` | Positive integer maximum rows rechecked per pruning transaction. |

Automatic retention prunes messages and stopped process records. Actor
instance expiration remains an explicit administration action even when a type
opts in.

## Authorization, instrumentation, and broadcast

All authorization callbacks default to `false`:

- `authorizeMessage({ actorType, actorId, operation, arguments,
authorizationContext })`
- `authorizeQuery({ actorType, actorId, operation, arguments,
authorizationContext })`
- `authorizeDestroy({ actorType, actorId, authorizationContext })`
- `authorizeAdministration({ action, resource, resourceId,
authorizationContext })`
- `authorizeSubscription({ actorType, actorId, authorizationContext })`

Callbacks may return a boolean or promise. Authorization contexts are
application-owned server values and are never persisted. See
[Authorization](authorization.md) for the entry-point matrix.

`instrumentation(event)` is synchronous. The runtime freezes metadata-only
events, catches sink failures, and reports the sink error through `logger`.

`broadcast(event)` forwards committed realtime invalidations through an
application-owned shared transport. A receiving process calls
`runtime.realtime.publish(event)`. It is unnecessary for a single-process
server.

## Database adapters

### Database value mapping

`DatabaseConnection.get<Row>()` and `all<Row>()` trust the caller-supplied row
type; they do not validate or convert driver results. Type rows to the adapter's
runtime representation or normalize them at the application boundary.

| SQL value                           | SQLite (`node:sqlite`)      | PostgreSQL (`pg`)                               | MySQL (`mysql2`)                    |
| ----------------------------------- | --------------------------- | ----------------------------------------------- | ----------------------------------- |
| ordinary integer                    | `bigint`                    | `number` for `int2`/`int4`; `bigint` for `int8` | `number` for ordinary integer types |
| arbitrary precision integer/decimal | `bigint` for SQLite INTEGER | `numeric` remains the driver's decimal string   | `BIGINT` and `DECIMAL` are strings  |
| floating point                      | `number`                    | `number`                                        | `number`                            |
| text                                | `string`                    | `string`                                        | `string`                            |
| binary                              | `Uint8Array`                | `Buffer`                                        | `Buffer`                            |
| null                                | `null`                      | `null`                                          | `null`                              |

`RunResult.changes` is always a `number`. `lastInsertId`, when an adapter
provides it, is a decimal `string`; SQLite and MySQL set it for nonzero generated
IDs, while PostgreSQL callers should use `RETURNING` with `get()`.

### SQLite

`sqlite({ path, timeoutMilliseconds = 5_000, lockRetryAttempts = 10 })` uses
Node's built-in `node:sqlite`. `lockRetryAttempts` is a positive integer. The
timeout controls SQLite's busy timeout; transaction acquisition retries use
short capped backoff only when no synchronous deadline is active.

### PostgreSQL

`postgresql(options)` accepts:

| Option                          |                    Default |
| ------------------------------- | -------------------------: |
| `connectionString`              |                   required |
| `maximumConnections`            |               `pg` default |
| `idleTimeoutMilliseconds`       |               `pg` default |
| `connectionTimeoutMilliseconds` |               `pg` default |
| `applicationName`               |          `"solid-objects"` |
| `onPoolError`                   | structured `console.error` |

`database.wakeUp(options)` creates a dedicated notification adapter using the
same connection string. Its options are `channelPrefix = "solid_objects"`,
`applicationName = "solid-objects-wake-up"`, and `onListenerError`. Use a
direct or session-pooled connection because PostgreSQL `LISTEN` is
session-scoped.

`postgresqlWakeUp({ connectionString, ...options })` constructs that adapter
without a database instance. The adapter translates portable `?` parameters;
write `??` in SQL passed through `DatabaseConnection` when PostgreSQL needs the
literal JSON existence operator.

### MySQL

`mysql(options)` accepts:

| Option                    |                      Default |
| ------------------------- | ---------------------------: |
| `connectionString`        |                     required |
| `maximumConnections`      |                         `10` |
| `idleTimeoutMilliseconds` |                     `60_000` |
| `queueLimit`              | `0` (unbounded driver queue) |

Counts are non-negative except `maximumConnections`, which is positive. Tables
use InnoDB. `mysqlSql(sql)` translates the limited portable conflict syntax
used by database integrations into MySQL syntax.

### Redis wake-up

`redisWakeUp({ url, channelPrefix = "solid_objects",
connectionTimeoutMilliseconds = 1_000, onError })` uses separate lazy
publisher and subscriber clients. Connection, subscription, and publication
failures are reported and bounded; database polling continues.

## Lifecycle order

Call `runtime.install()` before serving traffic or starting roles. Run the
supervisor with an application-owned abort signal. To shut down, abort, await
`runtime.run()`, then close adapters through `runtime.close()`:

```typescript
const controller = new AbortController()
const running = runtime.run(controller.signal)

controller.abort()
await running
await runtime.close()
```

Calling `close()` while `run()` is active raises an error so database and
wake-up connections cannot disappear beneath live roles.

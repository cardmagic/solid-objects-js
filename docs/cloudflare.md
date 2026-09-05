# Cloudflare Durable Objects

Import actor definitions from `solid-objects/core` to share them between Node
and Workers. On Cloudflare, import `createRuntime`, `durableObjects`,
`createDurableObjectsHost`, and `createDurableObjectsSessionHost` from
`solid-objects/cloudflare`.

The [runnable example](../examples/cloudflare/README.md) includes both Durable
Object classes, Wrangler bindings, migrations, and a public shopping cart.

## Configure the hosts

```typescript
import { createRuntime, durableObjects, withRuntime } from "solid-objects/cloudflare"

const runtime = createRuntime({
  backend: durableObjects({ namespace: env.ACTORS, sessions: env.SESSIONS }),
})

const counter = runtime.ref(Counter, "counter-1")
const count = await counter.with({ authorizationContext: subject }).increment()
await withRuntime(
  runtime,
  () => Counter.ref("counter-1").with({ authorizationContext: subject }).count,
)
```

Define the actor host once with `createDurableObjectsHost({ actors, configure })`.
`configure(env)` returns a `CloudflareConfiguration` with the same backend
bindings, authorization policies, and an `effects` map of named handlers. A
handler receives the existing effect arguments and `EffectContext` with its
stable delivery ID. Definitions and configuration stay inside the deployment;
they are not transmitted through RPC.

Use `runtime.ref()` or request-scoped `withRuntime()` in Worker handlers.
`Actor.ref()` within actor operations and lifecycle callbacks retains its
runtime across awaits. The backend does not set a global default runtime.

The host supplies storage and scheduling, so there is no `install()` or
`run()` step. Configure both exported classes using `new_sqlite_classes` and
enable `nodejs_compat` for async context propagation. Library schema migrations
run synchronously on activation and use a separate migration ledger.

## Guarantees and recovery

An actor type plus its string-normalized ID routes to one Durable Object.
Operations and getters enter its ordered durable mailbox. Snapshots read one
committed state image without entering the mailbox. A retryable head blocks
later turns, and permanent failures pause that actor until operator recovery.

State, results, effects, outbound messages, reminders, and the next alarm commit
together. Actor code executes outside that short transaction. Destruction and
restart generations fence stale commits. State migrations and read-only
projection checks use the same implementation as the SQL runtime.

Delivery is at least once. An effect can reach its external service before the
acknowledgement is stored. Deduplicate using `EffectContext.id`. `sendTo()` stores
an outbound intent in the source object and deduplicates acceptance in the
destination. This is eventual delivery, not a cross-object transaction.
Actors cannot synchronously call or wait on other actors.

One alarm covers the next due mailbox turn, retry, reminder, outbox delivery,
subscription expiry, or retention deadline. Persistent retry state supplements
Cloudflare's finite automatic alarm retries. Idle objects have no recurring
polling loop. Completed records default to 30 days of retention; dead letters
remain available for inspection. Idempotency receipts expire with their messages,
so callers must not rely on deduplication after the retention window.

An invocation timeout after acceptance raises `SyncTimeout` with a recoverable
`messageReference`. If RPC fails before an acceptance response arrives,
`EnqueueOutcomeUnknown.details` contains `actorType`, `actorId`, and `requestId`:

```typescript
const message = await runtime.lookupMessage({
  ...error.details,
  authorizationContext: subject,
})
if (message) await message.wait({ authorizationContext: subject })
```

A missing lookup is not proof that an outstanding enqueue cannot still arrive.
Look up again, or retry the application operation with its original explicit
idempotency key. Lookup requires query authorization for `__lookupMessage__`;
an existing message also requires authorization for its original operation.

Use `runtime.actorAdministration({ actorType, actorId, authorizationContext })`
for `deadLetters()`, `retryDeadLetter(id)`, `reminders()`, and
`resumeReminder({ name, runAt })`. Inspection is bounded to 1,000 records per
call. These operations call `authorizeAdministration` with resource
`actor:` followed by the canonical JSON identity tuple.

## Realtime sessions

The application authenticates its HTTP upgrade before calling
`runtime.openWebSocket({ sessionId, expiresAt })`. Forward the returned response
to the browser. `sessionId` must be an opaque application session reference,
not a bearer credential or serialized user object. Never forward client-supplied
`X-Solid-Session-*` headers to the session namespace.

The session host's `resolveAuthorizationContext({ sessionId, environment })`
loads current authorization data and returns JSON, or `null` when access has
expired or been revoked. It runs when opening the connection, subscribing, and
delivering events. Actor policies still authorize subscriptions and each named
personalized payload. Authentication remains application-owned.

One hibernating WebSocket multiplexes up to 100 actors by default. Configure
`maxSubscriptions` on the session host to change that limit. The browser client,
version-1 envelopes, value versus invalidation projections, personalized
payloads, and revision fences use the existing protocol.

The handshake uses Fetch because WebSocket upgrades cannot travel through
ordinary RPC. Actor-to-session events use RPC. Durable registrations survive
hibernation; disconnect and expiry trigger registration cleanup. Reconnects
replay current committed projections, not every event missed while offline.

## Capability boundaries

| Surface                                                            | Cloudflare backend                     |
| ------------------------------------------------------------------ | -------------------------------------- |
| Actor operations, getters, snapshots, state migrations             | Supported                              |
| Durable sends, results, retries, rejection, destruction            | Supported                              |
| Effects, reminders, cross-actor `sendTo()`                         | Supported                              |
| Browser subscriptions and personalized payloads                    | Supported through session hosts        |
| Actor-scoped dead letters and reminder administration              | Supported                              |
| `commitAction`, shared application SQL transactions                | Unsupported                            |
| Global repository, reconciliation, process controls, SQL dashboard | Unsupported                            |
| Process-local `runtime.realtime.connect()` / server `ref.live`     | Unsupported; use browser subscriptions |
| SQL-to-Durable-Objects data migration                              | Not provided                           |

Unsupported runtime facilities raise `UnsupportedCapability`; staging a commit
action permanently fails that turn before any state or intent commits.
Application and effect code must run within Workers' APIs and execution limits.
Arbitrary JavaScript is cooperative; caller timeout does not preempt it.
Eviction may discard private fields, and does not guarantee `onDeactivate()`.

State defaults to a 1 MiB limit. Encoded records, including indexed copies of
fields, must also fit Cloudflare's 2 MB SQLite row limit. Oversized records raise
`PayloadTooLarge`; increasing a configured payload limit cannot bypass the
[platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

Cloudflare hosting is JavaScript-specific. It does not change Ruby's SQL backend
or the guarantees of the existing SQL drivers.

## Validate and release

`pnpm run test:cloudflare` runs the Workers integration suite. `pnpm run check`
type-checks the separate Workers target alongside Node; `pnpm run check:cloudflare`
checks the example bundle and its imports. Keep backend schema changes additive.
Once an actor persists a newer state version, rollback to older actor code may
be unsafe; test that rollback against the stored version before deploying it.

Before calling this backend stable, run a deployed soak in a disposable
namespace covering alarms without traffic, eviction/restart recovery,
hibernation, and slow external effects. Local Workers tests do not establish
Cloudflare production failover behavior.

# Browser protocol

The browser entry point contains no Node imports. It sends versioned
subscription requests and receives JSON invalidation envelopes over WebSocket.
The application supplies the rendering callback and authenticated WebSocket
server; `runtime.realtime` supplies the server-side session protocol.

The `observables` object contains changed values and every subscriber authorized
for that actor receives the same projection. The `invalidations` array contains
changed observable names whose values were deliberately withheld with
`broadcastInvalidation()`. Use those names to refresh an application endpoint
that reauthorizes the component request. Use personalized payloads when the
browser needs subscriber-specific data, and keep secrets out of value-broadcast
observables.

The 0.1 subscription request is:

```json
{
  "version": 1,
  "action": "subscribe",
  "actorType": "Counter",
  "actorId": "primary",
  "payloads": ["summary"]
}
```

`unsubscribe` uses the same shape with `"action": "unsubscribe"`. The server
authorizes every subscribe request against the session's fresh connection
context before looking up the actor. A successful subscription immediately
sends the latest committed projection and then follows its durable outbox.

The 0.1 envelope is:

```json
{
  "version": 1,
  "kind": "invalidation",
  "actorType": "Counter",
  "actorId": "primary",
  "instanceId": "019...",
  "revision": "42",
  "observables": { "version": 3 },
  "invalidations": ["playerOne"]
}
```

`invalidations` was added as an optional version-1 field in 0.13.0. Clients
must treat a missing field as an empty array. A name appears in either
`observables` or `invalidations`, never both, in runtime-produced envelopes.

Requested personalized projections use a separate envelope:

```json
{
  "version": 1,
  "kind": "payload",
  "actorType": "Counter",
  "actorId": "primary",
  "instanceId": "019...",
  "revision": "42",
  "name": "summary",
  "payload": { "label": "Your counter", "count": 3 }
}
```

Invalidations and each payload name have independent revision fences. This
lets the server project the latest committed subscriber view even while an
older durable invalidation is being delivered. Payload bodies must be JSON
objects or arrays and are deeply frozen after parsing.

Revisions are non-negative integer strings so values larger than JavaScript's
safe integer range remain exact. A new instance ID establishes a new actor
incarnation and resets revision comparison. The runtime preserves revision
order per actor; server sessions and browser clients also reject duplicates and
stale revisions within an incarnation.

## Component refresh registry

`SolidObjectsComponentRegistry` maps changed observable names to keyed UI
registrations. The browser supplies an asynchronous `refresh` function and a
synchronous `apply` function. HTML, virtual DOM, and framework-native render
results therefore use the same coordination contract. The registry assumes no
render framework.

Components may share a batch name. A microtask unions affected components in
the same actor, batch, incarnation, and revision into one refresh request.
Unbatched components refresh independently. A strictly newer request aborts an
older request for the same group; same-revision requests do not cancel each
other. Results are accepted only for requested, still-registered targets, and
each target has its own incarnation/revision fence.

The registry never treats actor identity, component name, key, dependency, or
target as authorization. The application-owned refresh endpoint authenticates
the browser and reauthorizes every requested component before returning render
results.

`pnpm run test:browser` builds the browser entry and runs its Playwright suite
in Chromium. It covers native WebSocket subscription replay, stale revision and
incarnation handling, personalized payloads, component batching, and
superseded-request cancellation.

`runtime.realtime` delivers directly to sessions in its own Node process. For
several WebSocket processes, the configured `broadcast` callback publishes the
committed envelope through a shared transport and each process passes received
envelopes to `runtime.realtime.publish()`. The session fence safely drops the
duplicate seen by a process that both claimed and received the same event.

## Tab host channel protocol

`solid-objects/browser/tab-host` uses a second, unrelated wire surface: a
`BroadcastChannel` between tabs of one origin. Every envelope carries
`protocol: "solid-objects-tab-host"` and `version: 1`; a listener ignores
anything else. Three kinds exist:

- `invoke`: a client request with a `requestId` (a UUID the client generates),
  the target `actorType`, `actorId`, `operation`, and a JSON `arguments`
  object.
- `result`: the leader's answer for one `requestId`, with either an `ok`
  value or a named error.
- `leader-online`: the announcement a new leader posts on promotion. Clients
  re-post their pending requests when they see it.

The client retries an `invoke` on an interval until a `result` arrives or its
timeout passes. The leader enqueues each request with `tab:<requestId>` as the
idempotency key, so a retried or re-posted request applies once. The channel
is same-origin plumbing between the application's own tabs; it carries no
authentication, so the trust boundary is the origin.

## Sync envelope

`solid-objects/mirror` transmits one JSON envelope per staged sync
effect: `effectId`, target `actorType` and `actorId`, `operation`, and an
`arguments` object. The transport belongs to the host application; the
Playwright suite posts envelopes over `fetch`. The server calls
`receiveMirrorEnvelope`, which enqueues an internal message with
`mirror:<effectId>` as the idempotency key, so a replayed envelope applies once.
Internal delivery skips `authorizeMessage`; the host must authenticate the
sender before that call.

## Shared database channel protocol

`solid-objects/database/shared-sqlite-wasm` uses a third wire surface: a
`BroadcastChannel` that carries SQL sessions from every tab to the current
database holder. Every envelope carries
`protocol: "solid-objects-shared-sqlite"` and `version: 1`. Seven kinds
exist:

- `ping` and `pong`: holder discovery. A new instance pings until a holder
  answers with its `epoch`.
- `holder-online`: the announcement a new holder posts on promotion, with a
  fresh `epoch`.
- `open`: start a session (`connection` or `transaction`) with a client
  `sessionId`.
- `statement`: one `run`, `get`, `all`, or `now` operation inside a session.
- `close`: finish a session with `commit`, `rollback`, or `end`.
- `result`: the holder's answer for one `requestId`.

Every request carries the `epoch` it targets. A holder rejects requests from
another epoch, so a client learns about a failover from a fast rejection
rather than a timeout. A session that has not executed a statement retries
against the new holder automatically; later failures surface as
`SharedDatabaseFailover`, because a partially executed session must not
replay. The channel is same-origin plumbing with the origin as its trust
boundary, the same as the tab host protocol.

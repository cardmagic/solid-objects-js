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

`invalidations` was added as an optional version-1 field in 0.12.2. Clients
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
synchronous `apply` function, so HTML, virtual DOM, and framework-native render
results use the same coordination contract without assuming a rendering
framework.

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

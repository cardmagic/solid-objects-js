# Browser protocol

The browser entry point contains no Node imports. It sends versioned
subscription requests and receives JSON invalidation envelopes over WebSocket.
The application supplies the rendering callback and authenticated WebSocket
server; `runtime.realtime` supplies the server-side session protocol.

The 0.1 subscription request is:

```json
{
  "version": 1,
  "action": "subscribe",
  "actorType": "Counter",
  "actorId": "primary"
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
  "actorType": "Counter",
  "actorId": "primary",
  "instanceId": "019...",
  "revision": "42",
  "observables": { "count": 3 }
}
```

Revisions are non-negative integer strings so values larger than JavaScript's
safe integer range remain exact. A new instance ID establishes a new actor
incarnation and resets revision comparison. The runtime preserves revision
order per actor; server sessions and browser clients also reject duplicates and
stale revisions within an incarnation.

`runtime.realtime` delivers directly to sessions in its own Node process. For
several WebSocket processes, the configured `broadcast` callback publishes the
committed envelope through a shared transport and each process passes received
envelopes to `runtime.realtime.publish()`. The session fence safely drops the
duplicate seen by a process that both claimed and received the same event.

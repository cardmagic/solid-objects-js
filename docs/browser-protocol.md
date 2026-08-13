# Browser protocol

The browser entry point contains no Node imports. It receives versioned JSON
invalidation envelopes over WebSocket and rejects stale `(instance id,
revision)` deliveries. The application supplies the rendering callback and the
authenticated WebSocket server.

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
incarnation and resets revision comparison.

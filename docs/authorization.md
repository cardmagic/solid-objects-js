# Authorization

Actor identifiers are identifiers, not capabilities. Message, query,
destruction, subscription, and administration policies deny by default.
Applications must authorize the current server-side subject at every entry
point.

Dead-letter inspection and retry call `authorizeAdministration` with an action,
resource, optional resource ID, and the caller's authorization context. Retry
authorization happens before lookup so a denied caller cannot use record IDs as
an existence oracle.

`runtime.realtime` is transport-neutral. The host application authenticates its
WebSocket or stream connection, passes that fresh server-side subject as the
session's `authorizationContext`, and forwards incoming protocol messages to
`session.receive()`. Every subscribe request calls `authorizeSubscription`
before actor type lookup, so denied callers cannot probe the registry. A new
connection must use a newly resolved authorization context; do not copy a user
object from an earlier request or trust an actor ID supplied by the browser.

Successful subscription authorization allows the value-broadcast portion of
the explicit `observables()` projection for that actor, including the immediate
committed replay. Observables marked with `broadcastInvalidation()` disclose
only their names, not their values. Subscription authorization does not
authorize actor state, operations, queries, destruction, or administration.
The runtime removes all registrations when the host calls `session.close()`.

Requested personalized payloads cross both boundaries. The runtime first calls
`authorizeSubscription`, then calls `authorizeQuery` with the payload name and
the same fresh session authorization context before every projection. A false
query decision omits that payload. Projection and authorization failures are
confined to the payload name and emit metadata-only instrumentation; they do
not reject observable delivery or expose exception messages.

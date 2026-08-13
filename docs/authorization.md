# Authorization

Actor identifiers are identifiers, not capabilities. Message, query,
destruction, and administration policies deny by default. Applications must
authorize the current server-side subject at every entry point.

Dead-letter inspection and retry call `authorizeAdministration` with an action,
resource, optional resource ID, and the caller's authorization context. Retry
authorization happens before lookup so a denied caller cannot use record IDs as
an existence oracle.

The browser package is transport-only. The host application must authenticate
its WebSocket connection and authorize each subscription before forwarding
invalidation envelopes. Solid Objects does not provide a server subscription
endpoint in 0.1.

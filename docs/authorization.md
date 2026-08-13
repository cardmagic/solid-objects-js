# Authorization

Actor identifiers are identifiers, not capabilities. Message, query, and
destruction policies deny by default. Applications must authorize the current
server-side subject at every entry point.

The browser package is transport-only. The host application must authenticate
its WebSocket connection and authorize each subscription before forwarding
invalidation envelopes. Solid Objects does not provide a server subscription
endpoint in 0.1.

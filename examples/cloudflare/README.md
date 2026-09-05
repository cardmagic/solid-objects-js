# Cloudflare counter

This is an intentionally public counter. Anyone can increment it. Its policies
grant access only to `Counter("public-demo")`; destruction and administration
remain denied. Replace the demo session resolver with your application's
session lookup before using this example for private data.

From the repository root:

```sh
pnpm install
pnpm run build
pnpm run dev:cloudflare
```

In another terminal:

```sh
curl http://localhost:8787/counter
curl -X POST http://localhost:8787/increment
curl -X POST http://localhost:8787/increment-later
```

The last call schedules an increment five seconds later. Stop the local server
and start it again to verify persistence. Local state lives in Wrangler's
`.wrangler` directory. Each actor identity has its own SQLite-backed Durable
Object; browser connections use the separate `Sessions` class.

Connect the existing `SolidObjectsBrowserClient` to `/events` and subscribe to
`{ actorType: "Counter", actorId: "public-demo" }`. The connection expires after
one hour. Reconnect and resubscribe to obtain the current committed projection.

`pnpm run check:cloudflare` validates the production bundle without uploading it.
To deploy this example to your own account, run `fnox exec -- pnpm run deploy:cloudflare`.
Wrangler creates the two SQLite-backed namespaces using the configuration's
class migrations. No D1 database or external broker is required.

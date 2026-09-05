# Cloudflare shopping cart

This is an intentionally public shopping cart. Anyone can add or remove items
from `ShoppingCart("demo-cart")`; destruction and administration remain denied.
Replace the demo session resolver with your application's session lookup before
using this example for private data.

The example code is here:

- [`shopping-cart.ts`](./shopping-cart.ts) — actor state, cart operations, and realtime observables
- [`worker.ts`](./worker.ts) — Worker routes, authorization, and Durable Object hosts
- [`wrangler.jsonc`](./wrangler.jsonc) — SQLite-backed Durable Object bindings and migrations
- [`environment.d.ts`](./environment.d.ts) — generated Wrangler binding types

From the repository root:

```sh
pnpm install
pnpm run build
pnpm run dev:cloudflare
```

In another terminal:

```sh
curl http://localhost:8787/cart
curl -X POST http://localhost:8787/cart/items \
  -H 'content-type: application/json' \
  --data '{"sku":"book","name":"Solid Objects book","priceCents":2500,"quantity":1}'
curl -X POST http://localhost:8787/cart/remove \
  -H 'content-type: application/json' \
  --data '{"sku":"book"}'
curl -X POST http://localhost:8787/cart/clear-later
```

The last call schedules the cart to clear five seconds later. Stop the local
server and start it again to verify persistence. Local state lives in
Wrangler's `.wrangler` directory. Each actor identity has its own SQLite-backed
Durable Object; browser connections use the separate `Sessions` class.

Connect the existing `SolidObjectsBrowserClient` to `/events` and subscribe to
`{ actorType: "ShoppingCart", actorId: "demo-cart" }`. The connection expires
after one hour. Reconnect and resubscribe to obtain the current committed
projection with `itemCount` and `totalCents`.

`pnpm run check:cloudflare` validates the production bundle without uploading it.
To deploy this example to your own account, run `fnox exec -- pnpm run deploy:cloudflare`.
Wrangler creates the two SQLite-backed namespaces using the configuration's
class migrations. No D1 database or external broker is required.

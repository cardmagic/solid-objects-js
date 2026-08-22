# Operator dashboard

`solid-objects/web` is an optional operator interface over the same relational
tables used by the runtime. It exposes instances and committed state, ready and
claimed messages, reminders, effects, broadcasts, dead letters, and processes.
It needs no separate store or agent.

The root `solid-objects` entry point does not import the dashboard. A worker
process that never mounts it does not load its HTTP adapter, renderer, or
assets.

## Fetch mounting

`createDashboard()` returns an immutable Fetch handler. Give every request its
fresh server-side authentication context and the host session that should own
the CSRF token:

```typescript
import { createDashboard } from "solid-objects/web"

const dashboard = createDashboard({
  runtime,
  mountPath: "/solid-objects/dashboard",
})

const response = await dashboard.fetch(request, {
  authorizationContext: currentOperator,
  session: {
    read: (key) => session.get(key),
    write: (key, value) => session.set(key, value),
  },
})
```

`mountPath` defaults to `/solid-objects/dashboard`. Pass `/` only when the
dashboard owns the whole origin.

## Access modes

`access` defaults to `authorized`. Every route uses the runtime administration
policy, pages include mutation controls, and the request context must supply a
session for CSRF state.

Use `authorized-read-only` to retain the policy while removing mutation forms
and rejecting every dashboard POST with 405. Use `public-read-only` for an
explicitly public demo mount:

```typescript
const demo = createDashboard({
  runtime,
  mountPath: "/solid-objects/demo",
  access: "public-read-only",
})

await demo.fetch(request, {})
```

Public read-only mode skips `authorizeAdministration` and requires neither an
authorization context nor a session. It still exposes committed state,
arguments, results, errors, actor identifiers, and operational metadata. Only
use it with synthetic or otherwise public demo data. All extension GET routes
are public in this mode, while extension POST routes are also rejected.

## Node and Connect mounting

`createNodeDashboardHandler()` converts `IncomingMessage` and `ServerResponse`
to the Fetch contract. Register it after the application's authentication and
session middleware. A Connect-compatible host may pass `next`; paths outside
the mount and unknown dashboard paths cascade. Requests outside the mount
cascade before context resolution or body consumption, so downstream POST
handlers receive the original stream.

```typescript
import { createDashboard, createNodeDashboardHandler } from "solid-objects/web"

const dashboard = createDashboard({ runtime })
const handler = createNodeDashboardHandler({
  dashboard,
  resolveContext: async (request) => ({
    authorizationContext: await currentOperator(request),
    session: sessionFor(request),
  }),
})

app.use(handler)
```

The adapter caps request bodies at 64 KiB by default. Set
`maximumBodyBytes` to another positive bound when the host requires one.

## Authorization

In the default and authorized read-only modes, every data route declares an
`authorizeAdministration` action and resource. Authorization runs before the
route reads a record, so a denied caller cannot probe identifiers.

| Page or action                             | Action                     | Resource                      |
| ------------------------------------------ | -------------------------- | ----------------------------- |
| Dashboard, statistics, health              | `index`                    | `dashboard`                   |
| Instance list/detail                       | `index` / `show`           | `instances`                   |
| Instance pause/resume                      | `pause` / `resume`         | `instances`                   |
| Mailbox/message detail                     | `index` / `show`           | `messages`                    |
| Reminder, effect, broadcast, process lists | `index`                    | corresponding plural resource |
| Dead-letter list/detail/retry              | `index` / `show` / `retry` | `dead_letters`                |

The policy receives the route ID as `resourceId` when one exists and receives
the exact `authorizationContext` supplied by the host. The default policy
denies every route. Dashboard authorization does not authenticate requests;
resolve the operator before calling the dashboard.

## Security

The host session persists one random CSRF secret. Every rendered page masks it
with fresh random bytes, so tokens differ between requests while every form
already open in the same session remains valid. POST requests without a valid
token receive 403 and do not perform the action.

The dashboard escapes every stored or request-derived string before that string
enters the HTML. This includes the JSON in chart attributes. HTML and statistics
responses are private, and no cache holds them. The dashboard sends a nonce-backed content security
policy, denies framing, disables MIME sniffing, and limits referrers to the
same origin.

Page size defaults to 25 and is clamped to 200. Actor ID substring filtering is
parameterized with an adapter-specific SQL expression rather than interpolated
into a query.

## Pages and actions

The dashboard page shows totals, instances per actor type, mailbox depth,
outbox/reminder status, recent processes, and recent dead letters. The summary
bar can poll `/stats` every five seconds when the operator enables Live. Lists
do not reload underneath an operator reading them.

Instance detail shows committed state and recent related messages, reminders,
effects, broadcasts, and dead letters. Pause prevents workers from claiming
new turns for that identity; a turn already executing may still commit. Resume
clears the brake and normal polling resumes delivery.

Dead-letter retry calls `runtime.deadLetters.retry()`. It keeps the durable
idempotency and the actor-operation validation of that method. If the runtime
refuses a retry, the detail page shows it with status 422.

`HEAD /` performs only a schema reachability query and creates no CSRF session
state. Use it for liveness checks instead of polling the full dashboard.

## Charts

The dashboard defaults to Chart.js 4.5.0 from jsDelivr with subresource
integrity. Only that exact origin is added to `script-src`.

Use a self-hosted script without widening the policy:

```typescript
createDashboard({
  runtime,
  chartLibrary: { url: "/assets/chart.umd.min.js", integrity: null },
})
```

Set `chartLibrary: { url: null }` to render without charts. The dedicated chart
containers have fixed height so responsive redraws cannot grow the page.

## Extensions

Extensions are supplied when the dashboard is created. Configuration is copied
and frozen; there is no global registry and no first-request mutation boundary.

```typescript
const dashboard = createDashboard({
  runtime,
  extensions: [
    {
      tab: { label: "Tenants", path: "/tenants" },
      routes: [
        {
          method: "GET",
          path: "/tenants",
          policy: { action: "index", resource: "tenants" },
          handle: ({ render }) =>
            render({
              title: "Tenants",
              content: renderTenants(),
            }),
        },
      ],
    },
  ],
})
```

Every extension route must carry a nonempty policy. Missing policies and
method/path collisions fail when the dashboard is created. Renderer callbacks
may replace named built-in views, and Fetch middleware may wrap the whole
dashboard. Extension HTML is trusted application code; escape dynamic values
with the route context's `escape()` helper.

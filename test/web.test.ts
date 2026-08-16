import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { once } from "node:events"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import {
  createDashboard,
  createNodeDashboardHandler,
  type DashboardRequestContext,
  type DashboardSession,
} from "../src/web/index.js"

class DashboardActor extends Actor {
  static override readonly actorType = "DashboardActor"

  count = 0

  increment(): void {
    this.count += 1
  }
}

class TestSession implements DashboardSession {
  readonly values = new Map<string, string>()

  read(key: string): string | undefined {
    return this.values.get(key)
  }

  write(key: string, value: string): void {
    this.values.set(key, value)
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("operator dashboard", () => {
  it("denies every data route by default", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const dashboard = createDashboard({ runtime, mountPath: "/" })

    for (const path of ["/", "/instances", "/mailbox", "/stats", "/processes"]) {
      const response = await dashboard.fetch(request(path), context())

      expect(response.status, path).toBe(403)
    }
  })

  it("renders runtime data below the configured mount path", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    await DashboardActor.ref("alpha").increment()
    const dashboard = createDashboard({ runtime, mountPath: "/solid-objects/dashboard" })

    const response = await dashboard.fetch(request("/solid-objects/dashboard/instances"), context())
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain("DashboardActor")
    expect(body).toContain("alpha")
    expect(body).toContain("/solid-objects/dashboard/instances/")
  })

  it("passes route policy and request context before reading data", async () => {
    const seen: unknown[] = []
    runtime = configuredRuntime({
      authorizeAdministration: (input) => {
        seen.push(input)
        return true
      },
    })
    await runtime.install()
    const dashboard = createDashboard({ runtime, mountPath: "/" })
    const authorizationContext = { operatorId: "operator-1" }

    const response = await dashboard.fetch(request("/stats"), {
      authorizationContext,
      session: new TestSession(),
    })

    expect(response.status).toBe(200)
    expect(seen).toEqual([
      expect.objectContaining({
        action: "index",
        resource: "dashboard",
        authorizationContext,
      }),
    ])
  })

  it("requires a session-backed token for instance actions", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    await DashboardActor.ref("pausable").increment()
    const instance = await runtime.repository.findInstanceByIdentity(
      DashboardActor.actorType,
      "pausable",
    )
    expect(instance).toBeDefined()
    const dashboard = createDashboard({ runtime, mountPath: "/" })
    const requestContext = context()

    const rejected = await dashboard.fetch(
      request(`/instances/${instance?.id}/pause`, { method: "POST" }),
      requestContext,
    )
    expect(rejected.status).toBe(403)

    const page = await dashboard.fetch(request(`/instances/${instance?.id}`), requestContext)
    const token = (await page.text()).match(/name="authenticity_token" value="([^"]+)"/)?.[1]
    expect(token).toBeDefined()

    const paused = await dashboard.fetch(
      request(`/instances/${instance?.id}/pause`, {
        method: "POST",
        body: new URLSearchParams({ authenticity_token: token ?? "" }),
      }),
      requestContext,
    )
    expect(paused.status).toBe(303)

    const stored = await runtime.repository.findInstanceByIdentity(
      DashboardActor.actorType,
      "pausable",
    )
    expect(Number(stored?.paused)).toBe(1)

    const resumed = await dashboard.fetch(
      request(`/instances/${instance?.id}/resume`, {
        method: "POST",
        body: new URLSearchParams({ authenticity_token: token ?? "" }),
      }),
      requestContext,
    )
    expect(resumed.status).toBe(303)
    expect(
      Number(
        (await runtime.repository.findInstanceByIdentity(DashboardActor.actorType, "pausable"))
          ?.paused,
      ),
    ).toBe(0)
  })

  it("escapes stored identifiers and clamps pagination", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    for (const id of ["<script>alert(1)</script>", "second", "third"]) {
      await DashboardActor.ref(id).increment()
    }
    const dashboard = createDashboard({ runtime, mountPath: "/" })

    const response = await dashboard.fetch(request("/instances?per_page=200"), context())
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).not.toContain("<script>alert(1)</script>")
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    const paged = await dashboard.fetch(request("/instances?per_page=2"), context())
    const pagedBody = await paged.text()
    expect(pagedBody).toContain("1–2 of 3")
    expect(pagedBody).toContain("page=2")
  })

  it("serves every built-in page and cascade-capable unknown paths", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    const dashboard = createDashboard({ runtime, mountPath: "/" })

    for (const path of [
      "/",
      "/instances",
      "/mailbox",
      "/reminders",
      "/effects",
      "/broadcasts",
      "/dead-letters",
      "/processes",
      "/stats",
      "/assets/application.css",
      "/assets/application.js",
    ]) {
      expect((await dashboard.fetch(request(path), context())).status, path).toBe(200)
    }

    const missing = await dashboard.fetch(request("/missing"), context())
    expect(missing.status).toBe(404)
    expect(missing.headers.get("x-cascade")).toBe("pass")
  })

  it("sends strict security headers and configurable chart loading", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    const dashboard = createDashboard({ runtime, mountPath: "/" })

    const response = await dashboard.fetch(request("/"), context())
    const body = await response.text()
    const nonce = body.match(/nonce="([^"]+)"/)?.[1]
    const policy = response.headers.get("content-security-policy") ?? ""

    expect(nonce).toBeDefined()
    expect(policy).toContain(`'nonce-${nonce}'`)
    expect(policy).toContain("https://cdn.jsdelivr.net")
    expect(policy).not.toContain("'unsafe-inline'")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(body).toContain("sha384-")

    const chartless = createDashboard({
      runtime,
      mountPath: "/",
      chartLibrary: { url: null },
    })
    const chartlessResponse = await chartless.fetch(request("/"), context())
    expect(await chartlessResponse.text()).not.toContain("data-chart=")
    expect(chartlessResponse.headers.get("content-security-policy")).not.toContain("jsdelivr")
  })

  it("does not create CSRF state for a HEAD health check", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    const session = new TestSession()
    const dashboard = createDashboard({ runtime, mountPath: "/" })

    const response = await dashboard.fetch(request("/", { method: "HEAD" }), {
      authorizationContext: {},
      session,
    })

    expect(response.status).toBe(200)
    expect(session.values.size).toBe(0)
  })

  it("supports immutable extension routes, tabs, renderers, and middleware", async () => {
    const seen: string[] = []
    runtime = configuredRuntime({
      authorizeAdministration: ({ resource }) => {
        seen.push(resource)
        return true
      },
    })
    await runtime.install()
    const dashboard = createDashboard({
      runtime,
      mountPath: "/",
      extensions: [
        {
          tab: { label: "Probe", path: "/probe" },
          routes: [
            {
              method: "GET",
              path: "/probe",
              policy: { action: "index", resource: "probe" },
              handle: ({ render }) => render({ title: "Probe", content: "probe page" }),
            },
          ],
          renderers: {
            layout_content: ({ defaultHtml }) => `<div data-extension>${defaultHtml}</div>`,
          },
          middleware: [
            async (_input, next) => {
              const response = await next()
              const headers = new Headers(response.headers)
              headers.set("x-probe", "stamped")
              return new Response(response.body, { status: response.status, headers })
            },
          ],
        },
      ],
    })

    const response = await dashboard.fetch(request("/probe"), context())
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("x-probe")).toBe("stamped")
    expect(body).toContain("probe page")
    expect(body).toContain("data-extension")
    expect(body).toContain('href="/probe"')
    expect(seen).toEqual(["probe"])
  })

  it("rejects extension routes without policies and route collisions", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })

    expect(() =>
      createDashboard({
        runtime: runtime!,
        extensions: [
          {
            routes: [
              {
                method: "GET",
                path: "/unsafe",
                policy: undefined,
                handle: () => ({ title: "Unsafe", content: "unsafe" }),
              } as never,
            ],
          },
        ],
      }),
    ).toThrow(/authorization policy/)
    expect(() =>
      createDashboard({
        runtime: runtime!,
        extensions: [
          {
            routes: [
              {
                method: "GET",
                path: "/instances",
                policy: { action: "index", resource: "custom" },
                handle: () => ({ title: "Duplicate", content: "duplicate" }),
              },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate dashboard route/)
  })

  it("serves the Fetch dashboard through the Node adapter", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    await DashboardActor.ref("node-adapter").increment()
    const dashboard = createDashboard({ runtime, mountPath: "/dashboard" })
    const session = new TestSession()
    const handler = createNodeDashboardHandler({
      dashboard,
      resolveContext: () => ({ authorizationContext: {}, session }),
    })
    const server = createServer((incoming, outgoing) => handler(incoming, outgoing))
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("server did not bind a port")

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/dashboard/instances`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("node-adapter")
    } finally {
      server.close()
      await once(server, "close")
    }
  })

  it("cascades without consuming non-dashboard request bodies", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    const dashboard = createDashboard({ runtime, mountPath: "/dashboard" })
    let resolvedContexts = 0
    const handler = createNodeDashboardHandler({
      dashboard,
      resolveContext: () => {
        resolvedContexts += 1
        return context()
      },
    })
    const server = createServer((incoming, outgoing) => {
      handler(incoming, outgoing, (error) => {
        if (error) {
          outgoing.statusCode = 500
          outgoing.end(String(error))
          return
        }
        void requestText(incoming).then((body) => outgoing.end(body))
      })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("server did not bind a port")

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/application`, {
        method: "POST",
        body: "preserved",
      })
      expect(await response.text()).toBe("preserved")
      expect(resolvedContexts).toBe(0)
    } finally {
      server.close()
      await once(server, "close")
    }
  })
})

function configuredRuntime(
  overrides: {
    authorizeAdministration?: NonNullable<
      Parameters<typeof configure>[0]["authorizeAdministration"]
    >
  } = {},
): SolidObjectsRuntime {
  runtime = configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeAdministration: overrides.authorizeAdministration ?? (() => false),
  })
  runtime.register(DashboardActor)
  return runtime
}

function context(): DashboardRequestContext {
  return { authorizationContext: { source: "test" }, session: new TestSession() }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(new URL(path, "http://example.test"), init)
}

async function requestText(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString("utf8")
}

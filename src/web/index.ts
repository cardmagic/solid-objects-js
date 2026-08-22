import "../platform/node-context-store.js"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { Unauthorized, SolidObjectsError } from "../errors.js"
import {
  DASHBOARD_CHARTS_JAVASCRIPT,
  DASHBOARD_JAVASCRIPT,
  DASHBOARD_STYLESHEET,
} from "./assets.js"
import { DASHBOARD_COLUMNS, DashboardView, escapeHtml } from "./render.js"
import { DashboardStore } from "./store.js"
import type {
  DashboardAccess,
  DashboardChartLibrary,
  DashboardExtension,
  DashboardMiddleware,
  DashboardOptions,
  DashboardPage,
  DashboardPolicy,
  DashboardRequestContext,
  DashboardRoute,
  DashboardRouteContext,
  DashboardTab,
  SolidObjectsDashboardContract,
} from "./types.js"

export type {
  DashboardAccess,
  DashboardChartLibrary,
  DashboardExtension,
  DashboardMiddleware,
  DashboardMiddlewareInput,
  DashboardOptions,
  DashboardPage,
  DashboardPolicy,
  DashboardRenderer,
  DashboardRenderInput,
  DashboardRequestContext,
  DashboardRoute,
  DashboardRouteContext,
  DashboardSession,
  DashboardTab,
  NodeDashboardHandler,
  NodeDashboardHandlerOptions,
  NodeDashboardRequestContextResolver,
  SolidObjectsDashboardContract,
} from "./types.js"
export { createNodeDashboardHandler } from "./node.js"

const CHART_LIBRARY_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js"
const CHART_LIBRARY_INTEGRITY =
  "sha384-XcdcwHqIPULERb2yDEM4R0XaQKU3YnDsrTmjACBZyfdVVqjh6xQ4/DCMd7XLcA6Y"
const CSRF_SESSION_KEY = "solid_objects.dashboard.csrf"
const TOKEN_BYTES = 32
const MAXIMUM_FORM_BYTES = 65_536

const DEFAULT_TABS: readonly DashboardTab[] = [
  { label: "Dashboard", path: "/" },
  { label: "Instances", path: "/instances" },
  { label: "Mailbox", path: "/mailbox" },
  { label: "Reminders", path: "/reminders" },
  { label: "Effects", path: "/effects" },
  { label: "Broadcasts", path: "/broadcasts" },
  { label: "Dead letters", path: "/dead-letters" },
  { label: "Processes", path: "/processes" },
]

interface MatchedRoute {
  readonly route: DashboardRoute
  readonly params: Readonly<Record<string, string>>
}

interface InternalDashboardRouteContext extends DashboardRouteContext {
  readonly view: DashboardView
}

export class SolidObjectsDashboard implements SolidObjectsDashboardContract {
  readonly mountPath: string
  private readonly access: DashboardAccess
  private readonly store: DashboardStore
  private readonly routes: readonly DashboardRoute[]
  private readonly tabs: readonly DashboardTab[]
  private readonly renderers
  private readonly middleware: readonly DashboardMiddleware[]
  private readonly chartLibrary: DashboardChartLibrary

  constructor(private readonly options: DashboardOptions) {
    this.mountPath = normalizeMountPath(options.mountPath ?? "/solid-objects/dashboard")
    this.access = dashboardAccess(options.access)
    this.store = new DashboardStore(options.runtime)
    const extensions = Object.freeze([...(options.extensions ?? [])])
    this.routes = validateRoutes([...this.builtInRoutes(), ...extensions.flatMap(extensionRoutes)])
    this.tabs = Object.freeze([...DEFAULT_TABS, ...extensions.flatMap(extensionTabs)])
    this.renderers = Object.freeze(
      Object.assign({}, ...extensions.map((extension) => extension.renderers ?? {})),
    )
    this.middleware = Object.freeze([
      ...(options.middleware ?? []),
      ...extensions.flatMap((extension) => extension.middleware ?? []),
    ])
    this.chartLibrary = Object.freeze(
      options.chartLibrary ?? {
        url: CHART_LIBRARY_URL,
        integrity: CHART_LIBRARY_INTEGRITY,
      },
    )
  }

  async fetch(request: Request, requestContext: DashboardRequestContext): Promise<Response> {
    const input = Object.freeze({ request, requestContext })
    const dispatch = this.middleware.reduceRight<() => Promise<Response>>(
      (next, middleware) => () => middleware(input, next),
      () => this.dispatch(request, requestContext),
    )
    try {
      return await dispatch()
    } catch (error) {
      this.options.runtime.settings.logger.error({
        event: "solid_objects.dashboard.error",
        error: error instanceof Error ? error.name : "UnknownError",
      })
      return textResponse("Internal Server Error", { status: 500 })
    }
  }

  private async dispatch(
    request: Request,
    requestContext: DashboardRequestContext,
  ): Promise<Response> {
    const relativePath = this.relativePath(new URL(request.url).pathname)
    if (relativePath === undefined) return cascadeResponse()
    const asset = this.asset(relativePath)
    if (asset) return asset
    const matched = matchRoute({
      routes: this.routes,
      requestMethod: request.method,
      requestPath: relativePath,
    })
    if (!matched) return cascadeResponse()
    if (this.readOnly() && request.method === "POST") return methodNotAllowedResponse()
    const policy = matched.route.policy
    const resourceId = matched.params.id
    if (this.access !== "public-read-only") {
      const authorized = await this.options.runtime.settings.authorizeAdministration({
        action: policy.action,
        resource: policy.resource,
        ...(resourceId === undefined ? {} : { resourceId }),
        authorizationContext: requestContext.authorizationContext,
      })
      if (!authorized) return textResponse("Forbidden", { status: 403 })
    }
    if (request.method === "POST" && !(await validAuthenticityToken(request, requestContext))) {
      return textResponse("Forbidden", { status: 403 })
    }

    const pageResources =
      request.method === "HEAD" || relativePath === "/stats"
        ? undefined
        : await this.pageResources({ request, requestContext, relativePath })
    const routeContext: InternalDashboardRouteContext = Object.freeze({
      request,
      requestContext,
      params: matched.params,
      runtime: this.options.runtime,
      view: pageResources?.view as DashboardView,
      path: (path: string) => this.path(path),
      render: (page: DashboardPage) => {
        if (!pageResources) throw new TypeError("this route cannot render an HTML page")
        return this.htmlResponse(pageResources.view, page)
      },
      escape: escapeHtml,
    })
    try {
      const result = await matched.route.handle(routeContext)
      if (result instanceof Response) return result
      if (!pageResources) throw new TypeError("this route cannot return an HTML page")
      return this.htmlResponse(pageResources.view, result)
    } catch (error) {
      if (error instanceof Unauthorized) return textResponse("Forbidden", { status: 403 })
      throw error
    }
  }

  private async pageResources(options: {
    request: Request
    requestContext: DashboardRequestContext
    relativePath: string
  }): Promise<{ view: DashboardView }> {
    const statistics = await this.store.statistics()
    const csrfToken = this.readOnly()
      ? undefined
      : await maskedAuthenticityToken(options.requestContext)
    return {
      view: new DashboardView({
        mountPath: this.mountPath,
        currentPath: options.relativePath,
        nonce: randomBytes(16).toString("base64"),
        ...(csrfToken === undefined ? {} : { csrfToken }),
        readOnly: this.readOnly(),
        tabs: this.tabs,
        renderers: this.renderers,
        chartLibrary: this.chartLibrary,
        statistics,
      }),
    }
  }

  private htmlResponse(view: DashboardView, page: DashboardPage): Response {
    return new Response(view.page({ title: page.title, content: page.content }), {
      status: page.status ?? 200,
      headers: this.pageHeaders(view.nonce),
    })
  }

  private pageHeaders(nonce: string): Headers {
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    })
    headers.set(
      "content-security-policy",
      contentSecurityPolicy({ library: this.chartLibrary, nonce }),
    )
    return headers
  }

  private builtInRoutes(): readonly DashboardRoute[] {
    return [
      route({
        method: "HEAD",
        path: "/",
        policy: policy("index", "dashboard"),
        handle: async () => {
          await this.store.healthy()
          return new Response(null, {
            status: 200,
            headers: { "cache-control": "private, no-store" },
          })
        },
      }),
      route({
        method: "GET",
        path: "/",
        policy: policy("index", "dashboard"),
        handle: async (context) => {
          const { render, view } = internalContext(context)
          const model = await this.store.dashboard()
          return render({ title: "Dashboard", content: view.dashboard(model) })
        },
      }),
      route({
        method: "GET",
        path: "/stats",
        policy: policy("index", "dashboard"),
        handle: async () => jsonResponse(await this.store.statistics()),
      }),
      route({
        method: "GET",
        path: "/instances",
        policy: policy("index", "instances"),
        handle: async (context) => {
          const { request, view } = internalContext(context)
          const search = new URL(request.url).searchParams
          const page = await this.store.instances(pageOptions(search))
          return { title: "Instances", content: view.instances(page, search) }
        },
      }),
      route({
        method: "GET",
        path: "/instances/:id",
        policy: policy("show", "instances"),
        handle: async (context) => {
          const { params, view } = internalContext(context)
          const detail = await this.store.instance(requiredParam(params, "id"))
          if (!detail) return notFoundResponse()
          return {
            title: `${text(detail.instance.actor_type)} / ${text(detail.instance.actor_id)}`,
            content: view.instance(detail),
          }
        },
      }),
      route({
        method: "POST",
        path: "/instances/:id/pause",
        policy: policy("pause", "instances"),
        handle: async ({ params }) => {
          const id = requiredParam(params, "id")
          if (!(await this.store.setPaused({ id, paused: true }))) return notFoundResponse()
          return redirectResponse(this.path(`/instances/${id}`))
        },
      }),
      route({
        method: "POST",
        path: "/instances/:id/resume",
        policy: policy("resume", "instances"),
        handle: async ({ params }) => {
          const id = requiredParam(params, "id")
          if (!(await this.store.setPaused({ id, paused: false }))) return notFoundResponse()
          return redirectResponse(this.path(`/instances/${id}`))
        },
      }),
      route({
        method: "GET",
        path: "/mailbox",
        policy: policy("index", "messages"),
        handle: async (context) => {
          const { request, view } = internalContext(context)
          const search = new URL(request.url).searchParams
          const membership = search.get("membership") === "claimed" ? "claimed" : "ready"
          const page = await this.store.mailbox({ ...pageOptions(search), membership })
          const filter = `<form class="filters" method="get"><select name="membership"><option value="ready"${membership === "ready" ? " selected" : ""}>Ready</option><option value="claimed"${membership === "claimed" ? " selected" : ""}>Claimed</option></select><button type="submit">Filter</button></form>`
          return {
            title: "Mailbox",
            content: `${filter}${view.recordsPage({ title: "Mailbox", page, columns: DASHBOARD_COLUMNS.messages, extraQuery: { membership } })}`,
          }
        },
      }),
      route({
        method: "GET",
        path: "/messages/:id",
        policy: policy("show", "messages"),
        handle: async (context) => {
          const { params, view } = internalContext(context)
          const record = await this.store.message(requiredParam(params, "id"))
          if (!record) return notFoundResponse()
          return { title: "Message", content: view.message(record) }
        },
      }),
      route({
        method: "GET",
        path: "/reminders",
        policy: policy("index", "reminders"),
        handle: async (context) =>
          this.statusPage({
            context: internalContext(context),
            title: "Reminders",
            statuses: ["scheduled", "paused", "completed"],
            load: (search) => this.store.reminders(pageOptions(search)),
            columns: DASHBOARD_COLUMNS.reminders,
          }),
      }),
      route({
        method: "GET",
        path: "/effects",
        policy: policy("index", "effects"),
        handle: async (context) =>
          this.statusPage({
            context: internalContext(context),
            title: "Effects",
            statuses: ["pending", "processing", "completed", "dead"],
            load: (search) => this.store.effects(pageOptions(search)),
            columns: DASHBOARD_COLUMNS.effects,
          }),
      }),
      route({
        method: "GET",
        path: "/broadcasts",
        policy: policy("index", "broadcasts"),
        handle: async (context) =>
          this.statusPage({
            context: internalContext(context),
            title: "Broadcasts",
            statuses: ["pending", "processing", "delivered", "dead"],
            load: (search) => this.store.broadcasts(pageOptions(search)),
            columns: DASHBOARD_COLUMNS.broadcasts,
          }),
      }),
      route({
        method: "GET",
        path: "/dead-letters",
        policy: policy("index", "dead_letters"),
        handle: async (context) => {
          const { request, view } = internalContext(context)
          const search = new URL(request.url).searchParams
          const page = await this.store.deadLetters(pageOptions(search))
          return {
            title: "Dead letters",
            content: view.recordsPage({
              title: "Dead letters",
              page,
              columns: DASHBOARD_COLUMNS.deadLetters,
            }),
          }
        },
      }),
      route({
        method: "GET",
        path: "/dead-letters/:id",
        policy: policy("show", "dead_letters"),
        handle: async (context) => {
          const { params, view } = internalContext(context)
          const record = await this.store.deadLetter(requiredParam(params, "id"))
          if (!record) return notFoundResponse()
          return { title: "Dead letter", content: view.deadLetter(record) }
        },
      }),
      route({
        method: "POST",
        path: "/dead-letters/:id/retry",
        policy: policy("retry", "dead_letters"),
        handle: async (context) => {
          const { params, requestContext, view } = internalContext(context)
          const id = requiredParam(params, "id")
          try {
            await this.options.runtime.deadLetters.retry(id, {
              authorizationContext: requestContext.authorizationContext,
            })
            return redirectResponse(this.path("/dead-letters"))
          } catch (error) {
            if (!(error instanceof SolidObjectsError)) throw error
            const record = await this.store.deadLetter(id)
            if (!record) return notFoundResponse()
            return {
              title: "Dead letter",
              status: 422,
              content: view.deadLetter(record, `${error.name}: ${error.message}`),
            }
          }
        },
      }),
      route({
        method: "GET",
        path: "/processes",
        policy: policy("index", "processes"),
        handle: async (context) =>
          this.statusPage({
            context: internalContext(context),
            title: "Processes",
            statuses: ["running", "draining", "stopped"],
            load: (search) => this.store.processes(pageOptions(search)),
            columns: DASHBOARD_COLUMNS.processes,
          }),
      }),
    ]
  }

  private async statusPage(options: {
    context: InternalDashboardRouteContext
    title: string
    statuses: readonly string[]
    load(search: URLSearchParams): ReturnType<DashboardStore["effects"]>
    columns: typeof DASHBOARD_COLUMNS.effects
  }): Promise<DashboardPage> {
    const search = new URL(options.context.request.url).searchParams
    const status = options.statuses.includes(search.get("status") ?? "")
      ? search.get("status")
      : null
    const page = await options.load(search)
    const view = options.context.view
    return {
      title: options.title,
      content: view.recordsPage({
        title: options.title,
        page,
        columns: options.columns,
        status,
        statuses: options.statuses,
      }),
    }
  }

  private asset(relativePath: string): Response | undefined {
    if (relativePath === "/assets/application.css") {
      return assetResponse(DASHBOARD_STYLESHEET, "text/css; charset=utf-8")
    }
    if (relativePath === "/assets/application.js") {
      return assetResponse(DASHBOARD_JAVASCRIPT, "text/javascript; charset=utf-8")
    }
    if (relativePath === "/assets/charts.js") {
      return assetResponse(DASHBOARD_CHARTS_JAVASCRIPT, "text/javascript; charset=utf-8")
    }
    return undefined
  }

  private relativePath(pathname: string): string | undefined {
    if (this.mountPath === "") return pathname || "/"
    if (pathname === this.mountPath) return "/"
    if (!pathname.startsWith(`${this.mountPath}/`)) return undefined
    return pathname.slice(this.mountPath.length) || "/"
  }

  private path(path: string): string {
    if (path === "/") return this.mountPath || "/"
    return `${this.mountPath}${path}`
  }

  private readOnly(): boolean {
    return this.access !== "authorized"
  }
}

export function createDashboard(options: DashboardOptions): SolidObjectsDashboard {
  return new SolidObjectsDashboard(options)
}

function route(options: {
  method: DashboardRoute["method"]
  path: string
  policy: DashboardPolicy
  handle: DashboardRoute["handle"]
}): DashboardRoute {
  return Object.freeze(options)
}

function policy(action: string, resource: string): DashboardPolicy {
  return Object.freeze({ action, resource })
}

function validateRoutes(routes: readonly DashboardRoute[]): readonly DashboardRoute[] {
  const identities = new Set<string>()
  return Object.freeze(
    routes.map((item) => {
      if (!item.policy?.action || !item.policy.resource) {
        throw new TypeError(`dashboard route ${item.path} requires an authorization policy`)
      }
      if (!item.path.startsWith("/"))
        throw new TypeError(`dashboard route ${item.path} must start with /`)
      const identity = `${item.method} ${item.path}`
      if (identities.has(identity)) throw new TypeError(`duplicate dashboard route ${identity}`)
      identities.add(identity)
      return Object.freeze(item)
    }),
  )
}

function matchRoute(options: {
  routes: readonly DashboardRoute[]
  requestMethod: string
  requestPath: string
}): MatchedRoute | undefined {
  const { routes, requestMethod, requestPath } = options
  for (const item of routes) {
    if (item.method !== requestMethod) continue
    const patternParts = item.path.split("/")
    const pathParts = requestPath.split("/")
    if (patternParts.length !== pathParts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let index = 0; index < patternParts.length; index += 1) {
      const patternPart = patternParts[index] ?? ""
      const pathPart = pathParts[index] ?? ""
      if (patternPart.startsWith(":")) {
        try {
          params[patternPart.slice(1)] = decodeURIComponent(pathPart)
        } catch {
          matched = false
        }
      } else if (patternPart !== pathPart) {
        matched = false
      }
      if (!matched) break
    }
    if (matched) return { route: item, params: Object.freeze(params) }
  }
  return undefined
}

function extensionRoutes(extension: DashboardExtension): readonly DashboardRoute[] {
  return extension.routes ?? []
}

function extensionTabs(extension: DashboardExtension): readonly DashboardTab[] {
  return extension.tab ? [Object.freeze(extension.tab)] : []
}

async function maskedAuthenticityToken(context: DashboardRequestContext): Promise<string> {
  const session = context.session
  if (!session) throw new TypeError("read-write dashboard access requires a session")
  let raw = await session.read(CSRF_SESSION_KEY)
  if (!raw || !validRawToken(raw)) {
    raw = randomBytes(TOKEN_BYTES).toString("base64url")
    await session.write(CSRF_SESSION_KEY, raw)
  }
  const token = Buffer.from(raw, "base64url")
  const mask = randomBytes(TOKEN_BYTES)
  const masked = Buffer.alloc(TOKEN_BYTES)
  for (let index = 0; index < TOKEN_BYTES; index += 1) masked[index] = mask[index]! ^ token[index]!
  return Buffer.concat([mask, masked]).toString("base64url")
}

async function validAuthenticityToken(
  request: Request,
  context: DashboardRequestContext,
): Promise<boolean> {
  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (contentLength > MAXIMUM_FORM_BYTES) return false
  const body = await request.text()
  if (Buffer.byteLength(body) > MAXIMUM_FORM_BYTES) return false
  const submitted = new URLSearchParams(body).get("authenticity_token")
  const raw = await context.session?.read(CSRF_SESSION_KEY)
  if (!submitted || !raw || !validRawToken(raw)) return false
  try {
    const encoded = Buffer.from(submitted, "base64url")
    if (encoded.length !== TOKEN_BYTES * 2) return false
    const mask = encoded.subarray(0, TOKEN_BYTES)
    const masked = encoded.subarray(TOKEN_BYTES)
    const token = Buffer.alloc(TOKEN_BYTES)
    for (let index = 0; index < TOKEN_BYTES; index += 1)
      token[index] = mask[index]! ^ masked[index]!
    return timingSafeEqual(token, Buffer.from(raw, "base64url"))
  } catch {
    return false
  }
}

function validRawToken(value: string): boolean {
  try {
    return Buffer.from(value, "base64url").length === TOKEN_BYTES
  } catch {
    return false
  }
}

function normalizeMountPath(value: string): string {
  if (value === "/") return ""
  if (!value.startsWith("/")) throw new TypeError("dashboard mountPath must start with /")
  return value.replace(/\/+$/, "")
}

function dashboardAccess(value: DashboardAccess | undefined): DashboardAccess {
  if (value === undefined) return "authorized"
  if (["authorized", "authorized-read-only", "public-read-only"].includes(value)) return value
  throw new TypeError(`unsupported dashboard access mode ${String(value)}`)
}

function pageOptions(search: URLSearchParams): {
  page: string | null
  perPage: string | null
  status: string | null
  actorType: string | null
  actorId: string | null
} {
  return {
    page: search.get("page"),
    perPage: search.get("per_page"),
    status: search.get("status"),
    actorType: search.get("actor_type"),
    actorId: search.get("actor_id"),
  }
}

function contentSecurityPolicy(options: { library: DashboardChartLibrary; nonce: string }): string {
  const sources = ["'self'", `'nonce-${options.nonce}'`]
  if (options.library.url?.includes("//")) {
    try {
      sources.push(new URL(options.library.url).origin)
    } catch {}
  }
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'self'",
    `script-src ${sources.join(" ")}`,
    "connect-src 'self'",
    "object-src 'none'",
  ].join("; ")
}

function internalContext(context: DashboardRouteContext): InternalDashboardRouteContext {
  return context as InternalDashboardRouteContext
}

function requiredParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name]
  if (!value) throw new TypeError(`missing route parameter ${name}`)
  return value
}

function jsonResponse(value: unknown): Response {
  return new Response(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? String(item) : item,
    ),
    {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
      },
    },
  )
}

function textResponse(body: string, options: { status: number }): Response {
  return new Response(body, {
    status: options.status,
    headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" },
  })
}

function assetResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "cache-control": "private, max-age=86400",
      "content-type": contentType,
      "x-content-type-options": "nosniff",
    },
  })
}

function cascadeResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-cascade": "pass" },
  })
}

function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { location } })
}

function methodNotAllowedResponse(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      allow: "GET, HEAD",
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  })
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value)
}

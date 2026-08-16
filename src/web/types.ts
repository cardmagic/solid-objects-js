import type { IncomingMessage, ServerResponse } from "node:http"
import type { SolidObjectsRuntime } from "../runtime.js"

export interface DashboardSession {
  read(key: string): string | undefined | Promise<string | undefined>
  write(key: string, value: string): void | Promise<void>
}

export interface DashboardRequestContext {
  readonly authorizationContext?: unknown
  readonly session?: DashboardSession
}

export type DashboardAccess = "authorized" | "authorized-read-only" | "public-read-only"

export interface DashboardPolicy {
  readonly action: string
  readonly resource: string
}

export interface DashboardPage {
  readonly title: string
  readonly content: string
  readonly status?: number
}

export interface DashboardRenderInput {
  readonly name: string
  readonly model: Readonly<Record<string, unknown>>
  readonly defaultHtml: string
}

export type DashboardRenderer = (input: DashboardRenderInput) => string

export interface DashboardRouteContext {
  readonly request: Request
  readonly requestContext: DashboardRequestContext
  readonly params: Readonly<Record<string, string>>
  readonly runtime: SolidObjectsRuntime
  path(path: string): string
  render(page: DashboardPage): Response
  escape(value: unknown): string
}

export interface DashboardRoute {
  readonly method: "GET" | "HEAD" | "POST"
  readonly path: string
  readonly policy: DashboardPolicy
  handle(
    context: DashboardRouteContext,
  ): DashboardPage | Response | Promise<DashboardPage | Response>
}

export interface DashboardTab {
  readonly label: string
  readonly path: string
}

export interface DashboardExtension {
  readonly tab?: DashboardTab
  readonly routes?: readonly DashboardRoute[]
  readonly renderers?: Readonly<Record<string, DashboardRenderer>>
  readonly middleware?: readonly DashboardMiddleware[]
}

export interface DashboardMiddlewareInput {
  readonly request: Request
  readonly requestContext: DashboardRequestContext
}

export type DashboardMiddleware = (
  input: DashboardMiddlewareInput,
  next: () => Promise<Response>,
) => Promise<Response>

export interface DashboardChartLibrary {
  readonly url: string | null
  readonly integrity?: string | null
}

export interface DashboardOptions {
  readonly runtime: SolidObjectsRuntime
  readonly mountPath?: string
  readonly access?: DashboardAccess
  readonly chartLibrary?: DashboardChartLibrary
  readonly extensions?: readonly DashboardExtension[]
  readonly middleware?: readonly DashboardMiddleware[]
}

export interface NodeDashboardRequestContextResolver {
  (request: IncomingMessage): DashboardRequestContext | Promise<DashboardRequestContext>
}

export interface NodeDashboardHandlerOptions {
  readonly dashboard: SolidObjectsDashboardContract
  readonly resolveContext: NodeDashboardRequestContextResolver
  readonly maximumBodyBytes?: number
}

export interface SolidObjectsDashboardContract {
  readonly mountPath: string
  fetch(request: Request, context: DashboardRequestContext): Promise<Response>
}

export type NodeDashboardHandler = (
  ...argumentsValue: [IncomingMessage, ServerResponse, ((error?: unknown) => void)?]
) => void

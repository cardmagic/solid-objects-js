import type { IncomingMessage, ServerResponse } from "node:http"
import type { NodeDashboardHandler, NodeDashboardHandlerOptions } from "./types.js"

const DEFAULT_MAXIMUM_BODY_BYTES = 65_536

export function createNodeDashboardHandler(
  options: NodeDashboardHandlerOptions,
): NodeDashboardHandler {
  const maximumBodyBytes = options.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1) {
    throw new TypeError("maximumBodyBytes must be a positive safe integer")
  }
  return (...argumentsValue: [IncomingMessage, ServerResponse, ((error?: unknown) => void)?]) => {
    const [request, response, next] = argumentsValue
    void dispatchNodeRequest({
      options,
      maximumBodyBytes,
      request,
      response,
      ...(next === undefined ? {} : { next }),
    })
  }
}

async function dispatchNodeRequest(options: {
  options: NodeDashboardHandlerOptions
  maximumBodyBytes: number
  request: IncomingMessage
  response: ServerResponse
  next?: (error?: unknown) => void
}): Promise<void> {
  const { request, response, next } = options
  try {
    if (!matchesMountPath(request, options.options.dashboard.mountPath)) {
      if (next) {
        next()
        return
      }
      await writeResponse({
        response,
        result: new Response("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8", "x-cascade": "pass" },
        }),
      })
      return
    }
    const body = await requestBody({ request, maximumBodyBytes: options.maximumBodyBytes })
    if (body === undefined) {
      writeResponse({ response, result: new Response("Payload Too Large", { status: 413 }) })
      return
    }
    const host = request.headers.host ?? "localhost"
    const protocol = encrypted(request) ? "https" : "http"
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item)
      } else if (value !== undefined) {
        headers.set(name, value)
      }
    }
    const method = request.method ?? "GET"
    const webRequest = new Request(`${protocol}://${host}${request.url ?? "/"}`, {
      method,
      headers,
      ...(body.length === 0 || method === "GET" || method === "HEAD"
        ? {}
        : { body: new Uint8Array(body) }),
    })
    const context = await options.options.resolveContext(request)
    const result = await options.options.dashboard.fetch(webRequest, context)
    if (next && result.status === 404 && result.headers.get("x-cascade") === "pass") {
      next()
      return
    }
    await writeResponse({ response, result })
  } catch (error) {
    if (next) {
      next(error)
      return
    }
    if (!response.headersSent) {
      response.statusCode = 500
      response.setHeader("content-type", "text/plain; charset=utf-8")
    }
    response.end("Internal Server Error")
  }
}

async function requestBody(options: {
  request: IncomingMessage
  maximumBodyBytes: number
}): Promise<Buffer | undefined> {
  if (options.request.method === "GET" || options.request.method === "HEAD") return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of options.request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > options.maximumBodyBytes) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function writeResponse(options: {
  response: ServerResponse
  result: Response
}): Promise<void> {
  options.response.statusCode = options.result.status
  options.result.headers.forEach((value, name) => options.response.setHeader(name, value))
  const body = Buffer.from(await options.result.arrayBuffer())
  options.response.end(body)
}

function encrypted(request: IncomingMessage): boolean {
  return Boolean((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted)
}

function matchesMountPath(request: IncomingMessage, mountPath: string): boolean {
  if (mountPath === "") return true
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname
  return pathname === mountPath || pathname.startsWith(`${mountPath}/`)
}

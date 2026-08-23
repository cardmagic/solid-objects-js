import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { Actor, configure, receiveTransmitEnvelope } from "../dist/index.js"
import { sqlite } from "../dist/database/sqlite.js"
import { createDashboard, createNodeDashboardHandler } from "../dist/web/index.js"

const root = resolve(import.meta.dirname, "../dist")
const sqliteWasmRoot = resolve(import.meta.dirname, "../node_modules/@sqlite.org/sqlite-wasm/dist")
const signalPolyfillRoot = resolve(import.meta.dirname, "../node_modules/signal-polyfill/dist")
const browserFixtureRoot = resolve(import.meta.dirname, "browser")
const contentTypes = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
}
class DashboardBrowserActor extends Actor {
  static actorType = "DashboardBrowserActor"
  count = 0
  increment() {
    this.count += 1
  }
}
class TransmitCounter extends Actor {
  static actorType = "TransmitCounter"
  count = 0
  increment({ amount = 1 } = {}) {
    this.count += amount
    return this.count
  }
}
const runtime = configure({
  database: sqlite({ path: ":memory:" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  authorizeAdministration: () => true,
})
runtime.register(DashboardBrowserActor)
runtime.register(TransmitCounter)
await runtime.install()
await DashboardBrowserActor.ref("browser-room").increment()
const sessionValues = new Map()
const dashboard = createDashboard({
  runtime,
  mountPath: "/dashboard",
  chartLibrary: { url: "/chart-stub.js", integrity: null },
  middleware: [
    async ({ request }, next) => {
      const result = await next()
      if (!new URL(request.url).pathname.endsWith("/stats")) return result
      const statistics = await result.json()
      statistics.mailbox.ready = 1234
      statistics.mailbox.latency = 61.2
      return new Response(JSON.stringify(statistics), {
        status: result.status,
        headers: result.headers,
      })
    },
  ],
})
const dashboardHandler = createNodeDashboardHandler({
  dashboard,
  resolveContext: () => ({
    authorizationContext: { source: "browser" },
    session: {
      read: (key) => sessionValues.get(key),
      write: (key, value) => sessionValues.set(key, value),
    },
  }),
})
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (pathname === "/dashboard/chart-stub.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
    response.end(
      "window.Chart=class{constructor(canvas,configuration){this.canvas=canvas;this.data=configuration.data;canvas.dataset.rendered='true'}update(){this.canvas.dataset.updated='true'}}",
    )
    return
  }
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    dashboardHandler(request, response)
    return
  }
  if (pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end("<!doctype html><html><body></body></html>")
    return
  }
  if (pathname === "/sync" && request.method === "POST") {
    try {
      const envelope = JSON.parse(await readBody(request))
      await receiveTransmitEnvelope({ runtime, envelope })
      await runtime.testing.drain({ roles: ["actors"] })
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
    } catch (error) {
      response.writeHead(422, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: String(error?.message ?? error) }))
    }
    return
  }
  if (pathname === "/sync-state") {
    const actorId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("actorId")
    const snapshot = await runtime
      .ref(TransmitCounter, actorId ?? "missing")
      .snapshot()
      .catch(() => ({ count: 0 }))
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(snapshot))
    return
  }
  if (
    pathname === "/sqlite-wasm-worker.mjs" ||
    pathname === "/runtime-worker.mjs" ||
    pathname === "/tab-host-worker.mjs" ||
    pathname === "/transmit-worker.mjs" ||
    pathname === "/shared-db-worker.mjs" ||
    pathname === "/live-signals-worker.mjs"
  ) {
    await serveFile({ response, path: resolve(browserFixtureRoot, pathname.slice(1)) })
    return
  }
  if (pathname.startsWith("/vendor/signal-polyfill/")) {
    const vendorPath = resolve(
      signalPolyfillRoot,
      `.${pathname.slice("/vendor/signal-polyfill".length)}`,
    )
    if (!vendorPath.startsWith(`${signalPolyfillRoot}/`)) {
      response.writeHead(404)
      response.end()
      return
    }
    await serveFile({ response, path: vendorPath })
    return
  }
  if (pathname.startsWith("/vendor/sqlite-wasm/")) {
    const vendorPath = resolve(sqliteWasmRoot, `.${pathname.slice("/vendor/sqlite-wasm".length)}`)
    if (!vendorPath.startsWith(`${sqliteWasmRoot}/`)) {
      response.writeHead(404)
      response.end()
      return
    }
    await serveFile({ response, path: vendorPath })
    return
  }
  const path = resolve(root, `.${pathname}`)
  if (!path.startsWith(`${root}/`)) {
    response.writeHead(404)
    response.end()
    return
  }
  await serveFile({ response, path })
})

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    request.on("error", reject)
  })
}

async function serveFile({ response, path }) {
  try {
    let contents = await readFile(path)
    const contentType = contentTypes[extname(path)] ?? "text/plain"
    if (extname(path) === ".js" || extname(path) === ".mjs") {
      contents = contents
        .toString("utf-8")
        .replaceAll('"@sqlite.org/sqlite-wasm"', '"/vendor/sqlite-wasm/index.mjs"')
        .replaceAll('"signal-polyfill"', '"/vendor/signal-polyfill/index.js"')
    }
    response.writeHead(200, { "content-type": contentType })
    response.end(contents)
  } catch {
    response.writeHead(404)
    response.end()
  }
}

server.listen(4179, "127.0.0.1")

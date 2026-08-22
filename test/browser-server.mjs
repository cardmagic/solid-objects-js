import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { Actor, configure } from "../dist/index.js"
import { sqlite } from "../dist/database/sqlite.js"
import { createDashboard, createNodeDashboardHandler } from "../dist/web/index.js"

const root = resolve(import.meta.dirname, "../dist")
const sqliteWasmRoot = resolve(import.meta.dirname, "../node_modules/@sqlite.org/sqlite-wasm/dist")
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
const runtime = configure({
  database: sqlite({ path: ":memory:" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  authorizeAdministration: () => true,
})
runtime.register(DashboardBrowserActor)
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
  if (pathname === "/sqlite-wasm-worker.mjs" || pathname === "/runtime-worker.mjs") {
    await serveFile({ response, path: resolve(browserFixtureRoot, pathname.slice(1)) })
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

async function serveFile({ response, path }) {
  try {
    let contents = await readFile(path)
    const contentType = contentTypes[extname(path)] ?? "text/plain"
    if (extname(path) === ".js" || extname(path) === ".mjs") {
      contents = contents
        .toString("utf-8")
        .replaceAll('"@sqlite.org/sqlite-wasm"', '"/vendor/sqlite-wasm/index.mjs"')
    }
    response.writeHead(200, { "content-type": contentType })
    response.end(contents)
  } catch {
    response.writeHead(404)
    response.end()
  }
}

server.listen(4179, "127.0.0.1")

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../dist")
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end("<!doctype html><html><body></body></html>")
    return
  }
  const path = resolve(root, `.${pathname}`)
  if (!path.startsWith(`${root}/`)) {
    response.writeHead(404)
    response.end()
    return
  }
  try {
    const contents = await readFile(path)
    response.writeHead(200, {
      "content-type": extname(path) === ".js" ? "text/javascript; charset=utf-8" : "text/plain",
    })
    response.end(contents)
  } catch {
    response.writeHead(404)
    response.end()
  }
})

server.listen(4179, "127.0.0.1")

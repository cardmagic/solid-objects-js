import { Actor, configure, sqliteWasm } from "/browser/host.js"

class BrowserCounter extends Actor {
  static actorType = "BrowserCounter"

  count = 0

  increment() {
    this.count += 1
    return this.count
  }
}

self.onmessage = async (event) => {
  try {
    const report = await exercise(event.data)
    postMessage({ ok: true, report })
  } catch (error) {
    postMessage({
      ok: false,
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || ""),
    })
  }
}

async function exercise(instructions) {
  const database = await openWithRetry()
  const runtime = configure({
    database,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 5,
    syncPollingIntervalMilliseconds: 5,
  })
  try {
    await runtime.install()
    const counter = BrowserCounter.ref(instructions.actorId)
    const count = await counter.increment()
    const snapshot = await counter.snapshot()
    return { count, snapshot }
  } finally {
    await runtime.close()
    await database.close()
  }
}

async function openWithRetry() {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await sqliteWasm({ path: "solid-objects-runtime.db", storage: "persistent" })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError
}

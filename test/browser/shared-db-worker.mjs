import { Actor, configure, sharedSqliteWasm } from "/browser/host.js"

class Counter extends Actor {
  static actorType = "Counter"

  count = 0

  increment({ amount = 1 } = {}) {
    this.count += amount
    return this.count
  }
}

const database = sharedSqliteWasm({ path: "shared-app.db", name: "shared-e2e" })
const runtime = configure({
  database,
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  authorizeDestroy: () => true,
  pollingIntervalMilliseconds: 5,
  syncPollingIntervalMilliseconds: 5,
  idlePollingIntervalMilliseconds: 100,
  processAliveThresholdMilliseconds: 750,
  leaseDurationMilliseconds: 750,
  leaseRenewalIntervalMilliseconds: 250,
})
const installed = runtime.install()

self.onmessage = async (event) => {
  const { requestId, command, actorId } = event.data
  try {
    if (command === "role") {
      postMessage({ requestId, ok: true, value: database.role() })
      return
    }
    await installed
    const value = await Counter.ref(actorId).increment()
    postMessage({ requestId, ok: true, value })
  } catch (error) {
    postMessage({
      requestId,
      ok: false,
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || ""),
    })
  }
}

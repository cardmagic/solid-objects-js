import { Actor, configure, connectTabClient, sqliteWasm, startTabHost } from "/browser/host.js"

class TabCounter extends Actor {
  static actorType = "TabCounter"

  count = 0

  increment({ amount = 1 } = {}) {
    this.count += amount
    return this.count
  }
}

let lastHostError = ""

const host = startTabHost({
  name: "tab-host-e2e",
  onError: (error) => {
    lastHostError = `${error.name}: ${error.message}`
  },
  startRuntime: async () => {
    const database = await openWithRetry()
    try {
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
      runtime.register(TabCounter)
      await runtime.install()
      return {
        runtime,
        close: async () => {
          await runtime.close()
          await database.close()
        },
      }
    } catch (error) {
      await database.close()
      throw error
    }
  },
})

const client = connectTabClient({
  name: "tab-host-e2e",
  retryIntervalMilliseconds: 100,
  timeoutMilliseconds: 15_000,
})

self.onmessage = async (event) => {
  const { requestId, command, actorId } = event.data
  try {
    if (command === "role") {
      postMessage({ requestId, ok: true, value: host.role() })
      return
    }
    if (command === "diagnose") {
      postMessage({ requestId, ok: true, value: `${host.role()} ${lastHostError}` })
      return
    }
    const value = await client.invoke({
      actorType: "TabCounter",
      actorId,
      operation: "increment",
      arguments: {},
    })
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

async function openWithRetry() {
  let lastError
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await sqliteWasm({ path: "solid-objects-tab-host.db", storage: "persistent" })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError
}

import {
  Actor,
  configure,
  registerSyncBridge,
  SYNC_BRIDGE_EFFECT,
  sqliteWasm,
} from "/browser/host.js"

class MirrorCounter extends Actor {
  static actorType = "MirrorCounter"

  count = 0

  increment({ amount = 1 } = {}) {
    this.count += amount
    this.emit(SYNC_BRIDGE_EFFECT, {
      arguments: { operation: "increment", arguments: { amount } },
    })
    return this.count
  }
}

let stopRunning

self.onmessage = async (event) => {
  const { requestId, command, actorId, amounts } = event.data
  try {
    if (command === "stop") {
      await stopRunning?.()
      postMessage({ requestId, ok: true, value: "stopped" })
      return
    }
    const database = await sqliteWasm({ path: "sync-local.db" })
    const runtime = configure({
      database,
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      pollingIntervalMilliseconds: 5,
      syncPollingIntervalMilliseconds: 5,
    })
    registerSyncBridge({
      runtime,
      transmit: async (envelope) => {
        const response = await fetch("/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        })
        if (!response.ok) throw new Error(`sync transport failed with ${response.status}`)
      },
    })
    runtime.register(MirrorCounter)
    await runtime.install()
    const runAbort = new AbortController()
    const running = runtime.run(runAbort.signal)
    stopRunning = async () => {
      runAbort.abort()
      await running.catch(() => undefined)
      await runtime.close()
      await database.close()
    }
    let count = 0
    for (const amount of amounts) {
      count = await runtime.ref(MirrorCounter, actorId).increment({ amount })
    }
    postMessage({ requestId, ok: true, value: count })
  } catch (error) {
    postMessage({
      requestId,
      ok: false,
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || ""),
    })
  }
}

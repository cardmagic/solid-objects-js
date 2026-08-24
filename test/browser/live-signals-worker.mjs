import { Actor, broadcastValue, configure, sqliteWasm } from "/browser/host.js"
import "/signals.js"
import { Signal } from "signal-polyfill"

class LiveCounter extends Actor {
  static actorType = "LiveCounter"

  count = 0

  increment() {
    this.count += 1
    return this.count
  }

  observables() {
    return { count: broadcastValue(this.count) }
  }
}

self.onmessage = async (event) => {
  const { requestId } = event.data
  try {
    const database = await sqliteWasm({ path: "live-signals.db" })
    const runtime = configure({
      database,
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      authorizeSubscription: () => true,
      pollingIntervalMilliseconds: 5,
      syncPollingIntervalMilliseconds: 5,
    })
    runtime.register(LiveCounter)
    await runtime.install()
    const runAbort = new AbortController()
    const running = runtime.run(runAbort.signal)

    const counter = runtime.ref(LiveCounter, "browser-live")
    const observed = []
    const watcher = new Signal.subtle.Watcher(async () => {
      await 0
      observed.push(counter.live.count.get())
      watcher.watch()
    })
    watcher.watch(counter.live.count)
    counter.live.count.get()

    await counter.increment()
    await counter.increment()
    await waitFor(() => counter.live.count.get() === 2)

    watcher.unwatch(counter.live.count)
    runAbort.abort()
    await running.catch(() => undefined)
    await runtime.close()
    await database.close()
    postMessage({ requestId, ok: true, value: { final: 2, observed } })
  } catch (error) {
    postMessage({
      requestId,
      ok: false,
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || ""),
    })
  }
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("condition never became true")
}

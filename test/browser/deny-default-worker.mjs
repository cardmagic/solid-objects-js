import { Actor, configure, sqliteWasm } from "/browser/host.js"

class DenyCounter extends Actor {
  static actorType = "DenyCounter"

  count = 0

  increment() {
    this.count += 1
    return this.count
  }
}

self.onmessage = async () => {
  const database = await sqliteWasm({ path: "deny-default.db" })
  const runtime = configure({ database })
  try {
    await runtime.install()
    const value = await DenyCounter.ref("one").increment()
    postMessage({ ok: true, value })
  } catch (error) {
    postMessage({
      ok: false,
      name: error?.constructor?.name,
      message: String(error?.message ?? error),
    })
  } finally {
    await runtime.close()
    await database.close()
  }
}

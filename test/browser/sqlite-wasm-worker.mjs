import { registerContextStoreFactory } from "/platform/context-store.js"
import { TurnContextStore } from "/platform/turn-context-store.js"
import { sqliteWasm } from "/database/sqlite-wasm.js"

registerContextStoreFactory(() => new TurnContextStore())

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
  try {
    await database.connection((connection) =>
      connection.run("CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY, phase TEXT)"),
    )
    await database.transaction((connection) =>
      connection.run("INSERT INTO visits(phase) VALUES (?)", [instructions.phase]),
    )
    let rollbackMessage
    try {
      await database.transaction(async (connection) => {
        await connection.run("INSERT INTO visits(phase) VALUES (?)", ["rolled-back"])
        throw new Error("abort")
      })
    } catch (error) {
      rollbackMessage = String(error.message)
    }
    const rows = await database.connection((connection) =>
      connection.all("SELECT phase FROM visits ORDER BY id"),
    )
    const now = await database.connection((connection) => connection.nowMilliseconds())
    return {
      phases: rows.map((row) => row.phase),
      rollbackMessage,
      clockSkewMilliseconds: Math.abs(now - Date.now()),
    }
  } finally {
    await database.close()
  }
}

async function openWithRetry() {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await sqliteWasm({ path: "solid-objects-browser.db", storage: "persistent" })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError
}

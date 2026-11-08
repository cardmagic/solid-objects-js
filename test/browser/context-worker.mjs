import { Actor, createRuntime, sqliteWasm } from "/browser/host.js"
import { guardApplicationDatabase } from "/application-database.js"
import { withDatabaseTransaction } from "/database/transaction-context.js"

let applicationConnection

class GuardProbe extends Actor {
  static actorType = "GuardProbe"
  count = 0

  writeSynchronously() {
    applicationConnection.run("INSERT INTO attempts(boundary) VALUES ('synchronous')")
  }

  async writeAfterAwait({ boundary }) {
    this.count += 1
    if (boundary === "promise") await Promise.resolve()
    else await new Promise((resolve) => setTimeout(resolve, 0))
    await applicationConnection.get(
      "INSERT INTO attempts(boundary) VALUES (?) RETURNING boundary",
      [boundary],
    )
    throw new Error("roll back actor state")
  }

  increment() {
    this.count += 1
    return this.count
  }
}

self.onmessage = async () => {
  let runtime
  let applicationDatabase
  try {
    const database = await sqliteWasm({ path: ":memory:", storage: "temporary" })
    applicationDatabase = guardApplicationDatabase(
      await sqliteWasm({ path: ":memory:", storage: "temporary" }),
    )
    await applicationDatabase.connection(async (connection) => {
      applicationConnection = connection
      await connection.run("CREATE TABLE attempts(boundary TEXT)")
    })
    runtime = createRuntime({
      database,
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      maxAttempts: 1,
    })
    runtime.register(GuardProbe)
    await runtime.install()
    const reference = runtime.ref(GuardProbe, "guard-probe")
    const synchronous = await failure(() => reference.writeSynchronously())
    const promise = await failure(() => reference.writeAfterAwait({ boundary: "promise" }))
    const timer = await failure(() => reference.writeAfterAwait({ boundary: "timer" }))
    const rows = await applicationDatabase.connection((connection) =>
      connection.all("SELECT boundary FROM attempts ORDER BY rowid"),
    )
    const message = await reference.send.increment()
    const transaction = await withDatabaseTransaction(database, async () => {
      const beforeAwait = database.transactionActive()
      const waitError = await failure(() => message.wait())
      await Promise.resolve()
      // Do not attempt a wait after the guard disappears. In a real
      // transaction it could need the same database access queue being held.
      return { beforeAwait, afterAwait: database.transactionActive(), waitError }
    })
    const transactionCallbackActive = await database.transaction(async () =>
      database.transactionActive(),
    )
    const snapshot = await reference.snapshot()
    postMessage({
      ok: true,
      report: {
        synchronous,
        promise,
        timer,
        rows,
        transaction,
        transactionCallbackActive,
        snapshot,
      },
    })
  } catch (error) {
    postMessage({ ok: false, message: String(error.message), stack: String(error.stack) })
  } finally {
    await runtime?.close()
    await applicationDatabase?.close()
  }
}

async function failure(callback) {
  try {
    await callback()
    throw new Error("expected rejection")
  } catch (error) {
    return { name: error.name, details: error.details ?? null }
  }
}

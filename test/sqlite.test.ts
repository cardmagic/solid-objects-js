import { afterEach, describe, expect, it } from "vitest"
import { rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { sqlite, type SQLiteDatabase } from "../src/database/sqlite.js"

let database: SQLiteDatabase | undefined
let blocker: Worker | undefined
let path: string | undefined

afterEach(async () => {
  await blocker?.terminate()
  await database?.close()
  if (path) await rm(path, { force: true })
  database = undefined
  blocker = undefined
  path = undefined
})

describe("SQLite adapter", () => {
  it("retries a transaction after transient writer contention", async () => {
    path = `/tmp/solid-objects-sqlite-${crypto.randomUUID()}.sqlite3`
    const setup = new DatabaseSync(path)
    setup.exec("CREATE TABLE records(id INTEGER PRIMARY KEY)")
    setup.close()
    blocker = lockDatabase(path)
    await nextMessage(blocker)
    database = sqlite({ path, timeoutMilliseconds: 1, lockRetryAttempts: 10 })

    await database.transaction((connection) =>
      connection.run("INSERT INTO records(id) VALUES (?)", [1]),
    )

    await expect(
      database.connection((connection) =>
        connection.get<{ count: number | bigint }>("SELECT COUNT(*) AS count FROM records"),
      ),
    ).resolves.toEqual({ count: 1n })
  })

  it("validates its transaction retry budget", () => {
    expect(() => sqlite({ path: ":memory:", lockRetryAttempts: 0 })).toThrow(
      "lockRetryAttempts must be a positive safe integer",
    )
  })

  it("stops retrying after its transaction retry budget", async () => {
    path = `/tmp/solid-objects-sqlite-${crypto.randomUUID()}.sqlite3`
    const setup = new DatabaseSync(path)
    setup.exec("CREATE TABLE records(id INTEGER PRIMARY KEY)")
    setup.close()
    blocker = lockDatabase(path, { holdMilliseconds: 1_000 })
    await nextMessage(blocker)
    database = sqlite({ path, timeoutMilliseconds: 1, lockRetryAttempts: 2 })

    const startedAt = performance.now()
    await expect(
      database.transaction((connection) =>
        connection.run("INSERT INTO records(id) VALUES (?)", [1]),
      ),
    ).rejects.toThrow("database is locked")

    expect(performance.now() - startedAt).toBeLessThan(100)
  })
})

function lockDatabase(databasePath: string, options: { holdMilliseconds?: number } = {}): Worker {
  return new Worker(
    `
      const { DatabaseSync } = require("node:sqlite")
      const { parentPort, workerData } = require("node:worker_threads")
      const database = new DatabaseSync(workerData.databasePath)
      database.exec("BEGIN IMMEDIATE")
      parentPort.postMessage("locked")
      setTimeout(() => {
        database.exec("ROLLBACK")
        database.close()
      }, workerData.holdMilliseconds)
    `,
    {
      eval: true,
      workerData: { databasePath, holdMilliseconds: options.holdMilliseconds ?? 25 },
    },
  )
}

function nextMessage(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", reject)
  })
}

import { afterEach, describe, expect, it } from "vitest"
import "../src/platform/node.js"
import { Actor } from "../src/actor.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqliteWasm, type SQLiteWasmDatabase } from "../src/database/sqlite-wasm.js"
import { withDatabaseDeadline } from "../src/database/deadline.js"
import { DatabaseDeadlineExceeded } from "../src/errors.js"

class WasmCounter extends Actor {
  static override readonly actorType = "WasmCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }
}

let database: SQLiteWasmDatabase | undefined
let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  await database?.close()
  database = undefined
  runtime = undefined
})

describe("SQLite WASM adapter", () => {
  it("reports the sqlite family and a wasm schema identity", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    expect(database.family).toBe("sqlite")
    expect(database.schemaIdentity).toBe("solid-objects-wasm-v1")
  })

  it("runs statements and reports changes and the last insert id", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await database.connection((connection) =>
      connection.run("CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT)"),
    )
    const result = await database.connection((connection) =>
      connection.run("INSERT INTO records(name) VALUES (?)", ["first"]),
    )
    expect(result.changes).toBe(1)
    expect(result.lastInsertId).toBe("1")
  })

  it("reads single rows and row sets with bound parameters", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await database.connection(async (connection) => {
      await connection.run("CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT)")
      await connection.run("INSERT INTO records(name) VALUES (?), (?)", ["first", "second"])
    })
    const row = await database.connection((connection) =>
      connection.get<{ name: string }>("SELECT name FROM records WHERE id = ?", [2]),
    )
    expect(row).toEqual({ name: "second" })
    const missing = await database.connection((connection) =>
      connection.get<{ name: string }>("SELECT name FROM records WHERE id = ?", [99]),
    )
    expect(missing).toBeUndefined()
    const rows = await database.connection((connection) =>
      connection.all<{ name: string }>("SELECT name FROM records ORDER BY id"),
    )
    expect(rows).toEqual([{ name: "first" }, { name: "second" }])
  })

  it("normalizes boolean and undefined parameters", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await database.connection(async (connection) => {
      await connection.run("CREATE TABLE flags(id INTEGER PRIMARY KEY, active INTEGER, note TEXT)")
      await connection.run("INSERT INTO flags(active, note) VALUES (?, ?)", [true, undefined])
    })
    const row = await database.connection((connection) =>
      connection.get<{ active: number; note: null }>("SELECT active, note FROM flags"),
    )
    expect(row).toEqual({ active: 1, note: null })
  })

  it("rejects unsupported parameters", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await expect(
      database.connection((connection) => connection.run("SELECT ?", [Symbol("nope") as never])),
    ).rejects.toThrow("unsupported SQLite parameter")
  })

  it("reports wall-clock time from the database", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    const now = await database.connection((connection) => connection.nowMilliseconds())
    expect(Math.abs(now - Date.now())).toBeLessThan(5_000)
  })

  it("commits a transaction and reports it active inside the callback", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await database.connection((connection) =>
      connection.run("CREATE TABLE records(id INTEGER PRIMARY KEY)"),
    )
    expect(database.transactionActive()).toBe(false)
    await database.transaction(async (connection) => {
      expect(database?.transactionActive()).toBe(true)
      await connection.run("INSERT INTO records(id) VALUES (1)")
    })
    expect(database.transactionActive()).toBe(false)
    const row = await database.connection((connection) =>
      connection.get<{ count: number | bigint }>("SELECT COUNT(*) AS count FROM records"),
    )
    expect(Number(row?.count)).toBe(1)
  })

  it("rolls a transaction back when the callback throws", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await database.connection((connection) =>
      connection.run("CREATE TABLE records(id INTEGER PRIMARY KEY)"),
    )
    await expect(
      database.transaction(async (connection) => {
        await connection.run("INSERT INTO records(id) VALUES (1)")
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    const row = await database.connection((connection) =>
      connection.get<{ count: number | bigint }>("SELECT COUNT(*) AS count FROM records"),
    )
    expect(Number(row?.count)).toBe(0)
  })

  it("serializes concurrent access", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    const order: string[] = []
    await Promise.all([
      database.connection(async () => {
        order.push("first:start")
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push("first:end")
      }),
      database.connection(async () => {
        order.push("second:start")
        order.push("second:end")
      }),
    ])
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"])
  })

  it("expires queued work when the database deadline passes first", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    let release: (() => void) | undefined
    const blocked = database.connection(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    let queuedRan = false
    await expect(
      withDatabaseDeadline({ timeoutMilliseconds: 1 }, () =>
        database!.connection(async () => {
          queuedRan = true
        }),
      ),
    ).rejects.toBeInstanceOf(DatabaseDeadlineExceeded)
    release?.()
    await blocked
    expect(queuedRan).toBe(false)
  })

  it("rolls back a transaction that finishes after its deadline", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await database.connection((connection) =>
      connection.run("CREATE TABLE records(id INTEGER PRIMARY KEY)"),
    )
    await expect(
      withDatabaseDeadline({ timeoutMilliseconds: 10 }, () =>
        database!.transaction(async (connection) => {
          await connection.run("INSERT INTO records(id) VALUES (1)")
          await new Promise((resolve) => setTimeout(resolve, 30))
        }),
      ),
    ).rejects.toBeInstanceOf(DatabaseDeadlineExceeded)
    const row = await database.connection((connection) =>
      connection.get<{ count: number | bigint }>("SELECT COUNT(*) AS count FROM records"),
    )
    expect(Number(row?.count)).toBe(0)
  })

  it("closes idempotently and rejects work afterwards", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    await database.close()
    await database.close()
    await expect(database.connection((connection) => connection.run("SELECT 1"))).rejects.toThrow()
  })

  it("runs the full runtime against WASM storage", async () => {
    database = await sqliteWasm({ path: ":memory:" })
    runtime = configure({
      database,
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      pollingIntervalMilliseconds: 1,
      syncPollingIntervalMilliseconds: 1,
      maxAttempts: 2,
    })
    await runtime.install()
    const counter = WasmCounter.ref("wasm-primary")

    expect(await counter.increment({ amount: 3 })).toBe(3)
    expect(await counter.increment()).toBe(4)
    expect(await counter.count).toBe(4)
    expect(await counter.snapshot()).toEqual({ count: 4 })
  })
})

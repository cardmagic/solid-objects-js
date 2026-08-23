import { afterEach, describe, expect, it } from "vitest"
import "../src/platform/node.js"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import {
  sharedSqliteWasm,
  type SharedSQLiteWasmDatabase,
} from "../src/database/shared-sqlite-wasm.js"

class SharedCounter extends Actor {
  static override readonly actorType = "SharedCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }
}

const databases: SharedSQLiteWasmDatabase[] = []
const runtimes: SolidObjectsRuntime[] = []

afterEach(async () => {
  try {
    for (const runtime of [...runtimes].reverse()) await runtime.close()
    for (const database of [...databases].reverse()) await database.close()
  } finally {
    runtimes.length = 0
    databases.length = 0
  }
})

function shared(name: string, overrides: { sessionIdleTimeoutMilliseconds?: number } = {}) {
  const database = sharedSqliteWasm({ path: ":memory:", name, ...overrides })
  databases.push(database)
  return database
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("condition never became true")
}

const describeShared = globalThis.navigator?.locks ? describe : describe.skip

describeShared("shared SQLite WASM adapter", () => {
  it("executes statements from the holder and a remote instance", async () => {
    const name = `statements-${crypto.randomUUID()}`
    const first = shared(name)
    const second = shared(name)

    await first.connection(async (connection) => {
      await connection.run("CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT)")
      await connection.run("INSERT INTO records(name) VALUES (?)", ["from-first"])
    })
    const result = await second.connection((connection) =>
      connection.run("INSERT INTO records(name) VALUES (?)", ["from-second"]),
    )
    expect(result.changes).toBe(1)
    expect(result.lastInsertId).toBe("2")

    const rows = await second.connection((connection) =>
      connection.all<{ name: string }>("SELECT name FROM records ORDER BY id"),
    )
    expect(rows).toEqual([{ name: "from-first" }, { name: "from-second" }])

    const now = await second.connection((connection) => connection.nowMilliseconds())
    expect(Math.abs(now - Date.now())).toBeLessThan(5_000)
    expect([first.role(), second.role()].sort()).toEqual(["holder", "remote"])
  })

  it("commits and rolls back remote transactions", async () => {
    const name = `transactions-${crypto.randomUUID()}`
    const first = shared(name)
    const second = shared(name)
    await first.connection((connection) =>
      connection.run("CREATE TABLE records(id INTEGER PRIMARY KEY)"),
    )

    await second.transaction(async (connection) => {
      expect(second.transactionActive()).toBe(true)
      await connection.run("INSERT INTO records(id) VALUES (1)")
    })
    await expect(
      second.transaction(async (connection) => {
        await connection.run("INSERT INTO records(id) VALUES (2)")
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    const rows = await first.connection((connection) =>
      connection.all<{ id: number | bigint }>("SELECT id FROM records ORDER BY id"),
    )
    expect(rows.map((row) => Number(row.id))).toEqual([1])
  })

  it("serializes sessions across instances", async () => {
    const name = `serialize-${crypto.randomUUID()}`
    const first = shared(name)
    const second = shared(name)
    await first.connection((connection) => connection.run("SELECT 1"))

    const order: string[] = []
    let release: (() => void) | undefined
    const blocked = second.connection(async () => {
      order.push("second:start")
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push("second:end")
    })
    await eventually(() => release !== undefined)
    const chased = first.connection(async () => {
      order.push("first:start")
      order.push("first:end")
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release?.()
    await Promise.all([blocked, chased])

    expect(order).toEqual(["second:start", "second:end", "first:start", "first:end"])
  })

  it("runs two full runtimes against one shared database", async () => {
    const name = `runtimes-${crypto.randomUUID()}`
    const first = shared(name)
    const second = shared(name)
    const settings = {
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      pollingIntervalMilliseconds: 1,
      syncPollingIntervalMilliseconds: 1,
    }
    const firstRuntime = createRuntime({ database: first, ...settings })
    const secondRuntime = createRuntime({ database: second, ...settings })
    runtimes.push(firstRuntime, secondRuntime)

    await firstRuntime.install()
    await secondRuntime.install()

    expect(await firstRuntime.ref(SharedCounter, "shared").increment({ amount: 2 })).toBe(2)
    expect(await secondRuntime.ref(SharedCounter, "shared").increment()).toBe(3)
    expect(await secondRuntime.ref(SharedCounter, "shared").snapshot()).toEqual({ count: 3 })
  })

  it("fails over to the next instance when the holder closes", async () => {
    const name = `failover-${crypto.randomUUID()}`
    const first = shared(name)
    const second = shared(name)
    await first.connection((connection) => connection.run("SELECT 1"))
    await second.connection((connection) => connection.run("SELECT 1"))
    expect(first.role()).toBe("holder")

    await first.close()
    databases.splice(databases.indexOf(first), 1)

    await second.connection(async (connection) => {
      await connection.run("CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY)")
      await connection.run("INSERT INTO records(id) VALUES (1)")
    })
    expect(second.role()).toBe("holder")
  })

  it("recovers the session slot when a remote instance dies mid-session", async () => {
    const name = `watchdog-${crypto.randomUUID()}`
    const first = shared(name, { sessionIdleTimeoutMilliseconds: 100 })
    const second = shared(name)
    await first.connection((connection) => connection.run("SELECT 1"))

    let opened = false
    let releaseAbandoned = () => {}
    const held = new Promise<void>((resolve) => {
      releaseAbandoned = resolve
    })
    const abandoned = second
      .connection(async () => {
        opened = true
        await held
      })
      .catch(() => undefined)
    await eventually(() => opened)
    await second.close()
    databases.splice(databases.indexOf(second), 1)

    const value = await first.connection((connection) =>
      connection.get<{ answer: number | bigint }>("SELECT 42 AS answer"),
    )
    expect(Number(value?.answer)).toBe(42)
    releaseAbandoned()
    await abandoned
  })
})

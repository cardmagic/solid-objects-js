import { expect, it } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { benchmarkDurability } from "../benchmarks/durability.js"

it("serializes the actual SQLite durability settings despite bigint PRAGMA results", async () => {
  const database = sqlite({ path: ":memory:", synchronous: "full" })
  try {
    const raw = await database.connection((connection) =>
      connection.get<{ synchronous: bigint }>("PRAGMA synchronous"),
    )
    expect(typeof raw?.synchronous).toBe("bigint")
    const report = await benchmarkDurability(database)
    expect(JSON.parse(JSON.stringify(report))).toEqual({ journalMode: "memory", synchronous: 2 })
  } finally {
    await database.close()
  }
})

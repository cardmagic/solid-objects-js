import { describe, expect, it } from "vitest"
import { buildSettings, type SolidObjectsConfiguration } from "../src/configuration.js"
import type { Database } from "../src/database/types.js"
import { sqlite } from "../src/database/sqlite.js"
import { InProcessWakeUpAdapter } from "../src/wake-up.js"

function settingsFor(configuration: Partial<SolidObjectsConfiguration>) {
  return buildSettings({ database: sqlite({ path: ":memory:" }), ...configuration })
}

function databaseOfFamily(family: "postgresql" | "mysql"): Database {
  return {
    family,
    schemaIdentity: "test",
    connection: () => Promise.reject(new Error("unused")),
    transaction: () => Promise.reject(new Error("unused")),
    close: () => Promise.resolve(),
  }
}

describe("singleOwner configuration", () => {
  it("defaults to false", () => {
    expect(settingsFor({}).singleOwner).toBe(false)
  })

  it("accepts true with SQLite and in-process wake-ups", () => {
    expect(settingsFor({ singleOwner: true }).singleOwner).toBe(true)
    expect(settingsFor({ singleOwner: true, wakeUp: "in_process" }).singleOwner).toBe(true)
  })

  it("refuses a value that is not a boolean", () => {
    expect(() => settingsFor({ singleOwner: "yes" as unknown as boolean })).toThrow(
      "singleOwner must be a boolean",
    )
  })

  it.each(["postgresql", "mysql"] as const)("refuses a %s database", (family) => {
    expect(() => buildSettings({ database: databaseOfFamily(family), singleOwner: true })).toThrow(
      `singleOwner needs a SQLite database, and this database is ${family}`,
    )
  })

  it.each(["postgresql", "redis"] as const)("refuses the %s wake-up", (wakeUp) => {
    expect(() => settingsFor({ singleOwner: true, wakeUp })).toThrow(
      `singleOwner needs in-process wake-ups, and wakeUp is ${JSON.stringify(wakeUp)}`,
    )
  })

  it("refuses a wake-up adapter", () => {
    expect(() => settingsFor({ singleOwner: true, wakeUp: new InProcessWakeUpAdapter() })).toThrow(
      "singleOwner needs in-process wake-ups, and wakeUp is an adapter",
    )
  })

  it("keeps the other wake-up settings valid without singleOwner", () => {
    expect(settingsFor({ wakeUp: "redis" }).wakeUp).toBe("redis")
    expect(() => buildSettings({ database: databaseOfFamily("postgresql") })).not.toThrow()
  })
})

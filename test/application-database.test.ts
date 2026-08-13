import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { guardApplicationDatabase } from "../src/application-database.js"
import { sqlite, type SQLiteDatabase } from "../src/database/sqlite.js"
import type { Database } from "../src/database/types.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

let runtime: SolidObjectsRuntime | undefined
let rawApplicationDatabase: SQLiteDatabase | undefined
let applicationDatabase: Database

class DatabaseActor extends Actor {
  static override readonly actorType = "DatabaseActor"

  async read(): Promise<string | null> {
    const row = await applicationDatabase.connection((connection) =>
      connection.get<{ value: string }>("SELECT value FROM records WHERE id = 1"),
    )
    return row?.value ?? null
  }

  async writeDirectly(): Promise<void> {
    await applicationDatabase.connection((connection) =>
      connection.run("UPDATE records SET value = 'unsafe' WHERE id = 1"),
    )
  }

  writeAfterCommit(): void {
    this.commitAction("writeRecord", { value: "committed" })
  }
}

afterEach(async () => {
  await runtime?.close()
  await rawApplicationDatabase?.close()
  runtime = undefined
  rawApplicationDatabase = undefined
})

describe("guarded application database", () => {
  it("allows actor reads but rejects direct writes", async () => {
    await configure()
    const actor = DatabaseActor.ref("guarded")

    await expect(actor.read()).resolves.toBe("initial")
    await expect(actor.writeDirectly()).rejects.toThrow(
      "application database writes are forbidden during actor execution",
    )
    await expect(actor.read()).resolves.toBe("initial")
  })

  it("allows a registered commit action to use the same facade", async () => {
    await configure()

    await DatabaseActor.ref("commit").writeAfterCommit()

    await expect(DatabaseActor.ref("commit").read()).resolves.toBe("committed")
  })

  it("rejects write statements disguised as row-returning reads", async () => {
    await configure()

    await expect(
      applicationDatabase.connection((connection) =>
        connection.get("UPDATE records SET value = 'unsafe' WHERE id = 1 RETURNING value"),
      ),
    ).resolves.toEqual({ value: "unsafe" })
    await applicationDatabase.connection((connection) =>
      connection.run("UPDATE records SET value = 'initial' WHERE id = 1"),
    )

    class ReturningWriteActor extends Actor {
      static override readonly actorType = "ReturningWriteActor"

      async attempt(): Promise<void> {
        await applicationDatabase.connection((connection) =>
          connection.get("UPDATE records SET value = 'unsafe' WHERE id = 1 RETURNING value"),
        )
      }
    }
    runtime?.register(ReturningWriteActor)

    await expect(ReturningWriteActor.ref("one").attempt()).rejects.toThrow(
      "application database reads must begin with SELECT during actor execution",
    )
  })
})

async function configure(): Promise<void> {
  rawApplicationDatabase = sqlite({ path: ":memory:" })
  applicationDatabase = guardApplicationDatabase(rawApplicationDatabase)
  await applicationDatabase.connection(async (connection) => {
    await connection.run("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    await connection.run("INSERT INTO records (id, value) VALUES (1, 'initial')")
  })
  runtime = configureSolidObjects({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    maxAttempts: 1,
  })
  runtime.register(DatabaseActor)
  runtime.registerCommitAction("writeRecord", async ({ value }) => {
    await applicationDatabase.connection((connection) =>
      connection.run("UPDATE records SET value = ? WHERE id = 1", [value]),
    )
  })
  await runtime.install()
}

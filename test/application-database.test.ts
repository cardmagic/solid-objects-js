import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor, type PayloadBroadcasts } from "../src/actor.js"
import { guardApplicationDatabase } from "../src/application-database.js"
import { ApplicationWriteForbidden } from "../src/errors.js"
import { sqlite, type SQLiteDatabase } from "../src/database/sqlite.js"
import type { Database } from "../src/database/types.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"

let runtime: SolidObjectsRuntime | undefined
let rawApplicationDatabase: SQLiteDatabase | undefined
let applicationDatabase: Database

class DatabaseActor extends Actor {
  static override readonly actorType = "DatabaseActor"
  static override readonly payloads = {
    directWrite: async () => {
      await applicationDatabase.connection((connection) =>
        connection.run("UPDATE records SET value = 'unsafe' WHERE id = 1"),
      )
      return { written: true }
    },
  } satisfies PayloadBroadcasts<DatabaseActor, unknown>

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

  writeOutsideFence(): void {
    this.commitAction("writeExternalRecord", { value: "escaped" })
  }
}

class ActivatingDatabaseActor extends Actor {
  static override readonly actorType = "ActivatingDatabaseActor"

  protected override async onActivate(): Promise<void> {
    await applicationDatabase.connection((connection) =>
      connection.run("UPDATE records SET value = 'unsafe' WHERE id = 1"),
    )
  }

  run(): void {}
}

afterEach(async () => {
  await runtime?.close()
  await rawApplicationDatabase?.close()
  runtime = undefined
  rawApplicationDatabase = undefined
})

describe("guarded application database", () => {
  it("allows actor reads but rejects direct writes", async () => {
    await configureDatabases()
    const actor = DatabaseActor.ref("guarded")

    await expect(actor.read()).resolves.toBe("initial")
    await expect(actor.writeDirectly()).rejects.toMatchObject({
      details: { message: "application database writes are forbidden during actor execution" },
    })
    await expect(actor.read()).resolves.toBe("initial")
  })

  it("allows a registered commit action to use its fenced connection", async () => {
    await configureDatabases()

    await DatabaseActor.ref("commit").writeAfterCommit()

    const record = await runtime?.settings.database.connection((connection) =>
      connection.get<{ value: string }>("SELECT value FROM committed_records WHERE id = 1"),
    )
    expect(record?.value).toBe("committed")
  })

  it("rolls back a commit action that writes outside its fenced connection", async () => {
    await configureDatabases()
    const message = await DatabaseActor.ref("external").send.writeOutsideFence()

    expect(await runtime?.worker().runUntilIdle()).toBe(1)

    await expect(message.result()).rejects.toMatchObject({
      details: {
        name: "ApplicationWriteForbidden",
        message: "application database writes are forbidden during actor execution",
      },
    })
    await expect(DatabaseActor.ref("external").read()).resolves.toBe("initial")
  })

  it("rejects write statements disguised as row-returning reads", async () => {
    await configureDatabases()

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

    await expect(ReturningWriteActor.ref("one").attempt()).rejects.toMatchObject({
      details: {
        message: "application database reads must begin with SELECT during actor execution",
      },
    })
  })

  it("rejects writes from projections without rejecting the subscription", async () => {
    await configureDatabases()
    const send = vi.fn()
    const session = runtime?.realtime.connect({ authorizationContext: {}, send })

    await session?.receive({
      version: 1,
      action: "subscribe",
      actorType: DatabaseActor.actorType,
      actorId: "projected",
      payloads: ["directWrite"],
    })

    await expect(DatabaseActor.ref("projected").read()).resolves.toBe("initial")
    expect(send).toHaveBeenCalledOnce()
  })

  it("returns the message to ready when activation writes outside actor state", async () => {
    await configureDatabases()
    runtime?.register(ActivatingDatabaseActor)
    const message = await ActivatingDatabaseActor.ref("activation").send.run()

    await expect(message.wait()).rejects.toBeInstanceOf(ApplicationWriteForbidden)

    expect(await message.status()).toBe("ready")
    const record = await applicationDatabase.connection((connection) =>
      connection.get<{ value: string }>("SELECT value FROM records WHERE id = 1"),
    )
    expect(record?.value).toBe("initial")
  })
})

async function configureDatabases(): Promise<void> {
  rawApplicationDatabase = sqlite({ path: ":memory:" })
  applicationDatabase = guardApplicationDatabase(rawApplicationDatabase)
  await applicationDatabase.connection(async (connection) => {
    await connection.run("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    await connection.run("INSERT INTO records (id, value) VALUES (1, 'initial')")
  })
  runtime = configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeSubscription: () => true,
    maxAttempts: 1,
  })
  runtime.register(DatabaseActor)
  await runtime.settings.database.connection(async (connection) => {
    await connection.run("CREATE TABLE committed_records (id INTEGER PRIMARY KEY, value TEXT)")
    await connection.run("INSERT INTO committed_records (id, value) VALUES (1, 'initial')")
  })
  runtime.registerCommitAction("writeRecord", async ({ value }, context) => {
    await context.connection.run("UPDATE committed_records SET value = ? WHERE id = 1", [value])
  })
  runtime.registerCommitAction("writeExternalRecord", async ({ value }) => {
    await applicationDatabase.connection((connection) =>
      connection.run("UPDATE records SET value = ? WHERE id = 1", [value]),
    )
  })
  await runtime.install()
}

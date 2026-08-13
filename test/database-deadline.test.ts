import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { rm } from "node:fs/promises"
import { sqlite } from "../src/database/sqlite.js"
import { DatabaseDeadlineExceeded } from "../src/errors.js"
import { acquireBeforeDatabaseDeadline, withDatabaseDeadline } from "../src/database/deadline.js"

describe("database deadlines", () => {
  it("expires while waiting for serialized SQLite access without running queued work", async () => {
    const database = sqlite({ path: ":memory:" })
    let release: (() => void) | undefined
    const blocked = database.connection(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await eventually(() => release !== undefined)
    let queuedRan = false

    await expect(
      withDatabaseDeadline({ timeoutMilliseconds: 1 }, () =>
        database.connection(async () => {
          queuedRan = true
        }),
      ),
    ).rejects.toBeInstanceOf(DatabaseDeadlineExceeded)
    release?.()
    await blocked
    await database.connection(async () => {})

    expect(queuedRan).toBe(false)
    await database.close()
  })

  it("releases a pooled resource acquired after its deadline", async () => {
    let completeAcquisition: ((resource: string) => void) | undefined
    const acquisition = new Promise<string>((resolve) => {
      completeAcquisition = resolve
    })
    const released: string[] = []

    await expect(
      withDatabaseDeadline({ timeoutMilliseconds: 10 }, () =>
        acquireBeforeDatabaseDeadline(
          () => acquisition,
          (resource) => released.push(resource),
        ),
      ),
    ).rejects.toBeInstanceOf(DatabaseDeadlineExceeded)
    completeAcquisition?.("late connection")
    await eventually(() => released.length === 1)

    expect(released).toEqual(["late connection"])
  })

  it("does not start an acquisition after the deadline has expired", async () => {
    let acquisitions = 0

    await expect(
      withDatabaseDeadline({ timeoutMilliseconds: 0 }, () =>
        acquireBeforeDatabaseDeadline(
          () =>
            Promise.resolve().then(() => {
              acquisitions += 1
              return "connection"
            }),
          () => undefined,
        ),
      ),
    ).rejects.toBeInstanceOf(DatabaseDeadlineExceeded)

    expect(acquisitions).toBe(0)
  })

  it("applies and restores the remaining SQLite busy timeout", async () => {
    const database = sqlite({ path: ":memory:", timeoutMilliseconds: 5_000 })
    const withinDeadline = await withDatabaseDeadline({ timeoutMilliseconds: 50 }, () =>
      database.connection((connection) =>
        connection.get<{ timeout: number | bigint }>("PRAGMA busy_timeout"),
      ),
    )
    const restored = await database.connection((connection) =>
      connection.get<{ timeout: number | bigint }>("PRAGMA busy_timeout"),
    )

    expect(Number(withinDeadline?.timeout)).toBeGreaterThan(0)
    expect(Number(withinDeadline?.timeout)).toBeLessThanOrEqual(50)
    expect(Number(restored?.timeout)).toBe(5_000)
    await database.close()
  })

  it("turns SQLite lock contention into a deadline error", async () => {
    const path = `/tmp/solid-objects-deadline-${crypto.randomUUID()}.sqlite3`
    const blocker = new DatabaseSync(path)
    blocker.exec("CREATE TABLE records(id INTEGER PRIMARY KEY)")
    blocker.exec("BEGIN IMMEDIATE")
    const database = sqlite({ path, timeoutMilliseconds: 5_000 })

    try {
      await expect(
        withDatabaseDeadline({ timeoutMilliseconds: 10 }, () =>
          database.transaction(async (connection) => {
            await connection.run("INSERT INTO records(id) VALUES (1)")
          }),
        ),
      ).rejects.toBeInstanceOf(DatabaseDeadlineExceeded)
    } finally {
      blocker.exec("ROLLBACK")
      blocker.close()
      await database.close()
      await rm(path, { force: true })
    }
  })
})

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("condition was not met")
}

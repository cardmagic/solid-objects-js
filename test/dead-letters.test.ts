import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

class PoisonActor extends Actor {
  static override readonly actorType = "PoisonActor"
  static fail = true

  runs = 0

  run({ source }: { source: string }): number {
    if (PoisonActor.fail) throw new Error(`poison message from ${source}`)
    this.runs += 1
    return this.runs
  }
}

let runtime: SolidObjectsRuntime | undefined
const temporaryDirectories: string[] = []

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  PoisonActor.fail = true
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("dead-letter administration", () => {
  it("denies inspection and retry before revealing whether a record exists", async () => {
    runtime = configureSolidObjects({ database: sqlite({ path: ":memory:" }) })
    await runtime.install()

    await expect(runtime.deadLetters.all()).rejects.toBeInstanceOf(Unauthorized)
    await expect(runtime.deadLetters.retry("missing")).rejects.toBeInstanceOf(Unauthorized)
  })

  it("returns immutable failure records to authorized administrators", async () => {
    const authorizations: unknown[] = []
    runtime = configuredRuntime({
      authorizeAdministration: (input) => {
        authorizations.push(input)
        return input.authorizationContext === "operator"
      },
    })
    await runtime.install()
    await createDeadLetter(runtime)
    authorizations.length = 0

    const deadLetters = await runtime.deadLetters.all({ authorizationContext: "operator" })

    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0]).toMatchObject({
      actorType: "PoisonActor",
      actorId: "one",
      operation: "run",
      deliveryMode: "async",
      arguments: { source: "test" },
      attempts: 1,
      error: { name: "Error", message: "poison message from test" },
      retriedMessageId: null,
    })
    expect(deadLetters[0]?.createdAt).toBeInstanceOf(Date)
    expect(Object.isFrozen(deadLetters)).toBe(true)
    expect(Object.isFrozen(deadLetters[0])).toBe(true)
    expect(Object.isFrozen(deadLetters[0]?.arguments)).toBe(true)
    expect(authorizations).toEqual([
      {
        action: "inspect",
        resource: "dead_letters",
        authorizationContext: "operator",
      },
    ])
  })

  it("retries a dead message through the durable mailbox exactly once", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()
    const deadLetter = await createDeadLetter(runtime)
    PoisonActor.fail = false

    const first = await runtime.deadLetters.retry(deadLetter.id, {
      authorizationContext: "operator",
    })
    const second = await runtime.deadLetters.retry(deadLetter.id, {
      authorizationContext: "operator",
    })

    expect(second.id).toBe(first.id)
    expect(await runtime.worker().runUntilIdle()).toBe(1)
    expect(await first.result()).toBe(1)
    const retried = await runtime.deadLetters.all({ authorizationContext: "operator" })
    expect(retried[0]?.retriedMessageId).toBe(first.id)
  })

  it("reports a missing record only after administration authorization", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => true })
    await runtime.install()

    await expect(
      runtime.deadLetters.retry("missing", { authorizationContext: "operator" }),
    ).rejects.toThrow("unknown dead letter missing")
  })
})

describe("schema migrations", () => {
  it("upgrades an existing version-one database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "solid-objects-schema-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "database.sqlite3")
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE solid_objects_schema_migrations (
        version INTEGER PRIMARY KEY,
        schema_identity TEXT NOT NULL,
        installed_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO solid_objects_schema_migrations
        (version, schema_identity, installed_at_ms)
        VALUES (1, 'solid-objects-node-v1', 0);
      CREATE TABLE solid_objects_dead_letters (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        instance_id TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts > 0),
        error TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;
    `)
    database.close()
    runtime = configuredRuntime({ database: sqlite({ path }) })

    await runtime.install()

    const versions = await runtime.settings.database.connection((connection) =>
      connection.all<{ version: number | bigint }>(
        "SELECT version FROM solid_objects_schema_migrations ORDER BY version",
      ),
    )
    const columns = await runtime.settings.database.connection((connection) =>
      connection.all<{ name: string }>("PRAGMA table_info(solid_objects_dead_letters)"),
    )
    expect(versions.map(({ version }) => Number(version))).toEqual([1, 2])
    expect(columns.map(({ name }) => name)).toContain("retried_message_id")
  })
})

async function createDeadLetter(currentRuntime: SolidObjectsRuntime) {
  const message = await PoisonActor.ref("one").send.run({ source: "test" })
  expect(await currentRuntime.worker().runUntilIdle()).toBe(1)
  expect(await message.status()).toBe("dead")
  const deadLetters = await currentRuntime.deadLetters.all({ authorizationContext: "operator" })
  const deadLetter = deadLetters[0]
  if (!deadLetter) throw new Error("expected a dead letter")
  return deadLetter
}

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configureSolidObjects({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 1,
    ...overrides,
  })
}

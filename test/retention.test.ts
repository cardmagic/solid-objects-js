import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { buildSettings, type SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

const DAY = 24 * 60 * 60 * 1_000

class RetentionActor extends Actor {
  static override readonly actorType = "RetentionActor"

  count = 0

  increment(): void {
    this.count += 1
  }

  fail(): void {
    throw new Error("failed")
  }

  emitUnfinishedEffect(): void {
    this.emit("unfinishedRetentionEffect")
  }

  scheduleIncrement(): void {
    this.schedule({ at: new Date(Date.now() + DAY) }).increment!()
  }
}

class ShortRetentionActor extends Actor {
  static override readonly actorType = "ShortRetentionActor"

  run(): void {}
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("retention", () => {
  it("validates retention durations and batch size", async () => {
    const database = sqlite({ path: ":memory:" })
    expect(() => buildSettings({ database, messageRetentionMilliseconds: 0 })).toThrow(
      "messageRetentionMilliseconds must be positive",
    )
    expect(() =>
      buildSettings({ database, instanceRetentionByActorType: { RetentionActor: -1 } }),
    ).toThrow("instanceRetentionByActorType values must be positive")
    expect(() => buildSettings({ database, pruneBatchSize: 0 })).toThrow(
      "pruneBatchSize must be a positive safe integer",
    )
    await database.close()
  })

  it("denies preview and pruning when no administration policy is configured", async () => {
    runtime = configureSolidObjects({ database: sqlite({ path: ":memory:" }) })
    await runtime.install()

    await expect(runtime.retention.preview({ target: "messages" })).rejects.toBeInstanceOf(
      Unauthorized,
    )
    await expect(runtime.retention.prune({ target: "messages" })).rejects.toBeInstanceOf(
      Unauthorized,
    )
  })

  it("rejects unknown retention targets at runtime", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await expect(runtime.retention.preview({ target: "unknown" as "messages" })).rejects.toThrow(
      'unknown retention target "unknown"',
    )
  })

  it("previews and prunes only terminal unreferenced message history", async () => {
    runtime = configuredRuntime({ maxAttempts: 1, pruneBatchSize: 1 })
    await runtime.install()
    const old = await RetentionActor.ref("old").send.increment()
    const secondOld = await RetentionActor.ref("second-old").send.increment()
    const recent = await RetentionActor.ref("recent").send.increment()
    const protectedMessage = await RetentionActor.ref("effect").send.emitUnfinishedEffect()
    const ready = await RetentionActor.ref("ready")
      .send.with({ availableAt: new Date(Date.now() + DAY) })
      .increment()
    const dead = await RetentionActor.ref("dead").send.fail()
    await runtime.worker().runUntilIdle()
    const oldTimestamp = Date.now() - 31 * DAY
    await ageMessages([old.id, secondOld.id, protectedMessage.id, dead.id], oldTimestamp)

    const preview = await runtime.retention.preview({ target: "messages" })

    expect(preview).toEqual({ target: "messages", count: 2 })
    expect(await runtime.retention.prune({ target: "messages" })).toEqual({
      target: "messages",
      count: 2,
    })
    expect(await runtime.repository.findMessage(old.id)).toBeUndefined()
    expect(await runtime.repository.findMessage(secondOld.id)).toBeUndefined()
    expect(await runtime.repository.findMessage(recent.id)).toBeDefined()
    expect(await runtime.repository.findMessage(protectedMessage.id)).toBeDefined()
    expect(await runtime.repository.findMessage(ready.id)).toBeDefined()
    expect(await runtime.repository.findMessage(dead.id)).toBeDefined()
  })

  it("honors per-actor message retention", async () => {
    runtime = configuredRuntime({
      messageRetentionByActorType: { [ShortRetentionActor.actorType]: DAY },
    })
    await runtime.install()
    const defaultMessage = await RetentionActor.ref("default").send.increment()
    const shortMessage = await ShortRetentionActor.ref("short").send.run()
    await runtime.worker().runUntilIdle()
    await ageMessages([defaultMessage.id, shortMessage.id], Date.now() - 2 * DAY)

    expect(await runtime.retention.prune({ target: "messages" })).toEqual({
      target: "messages",
      count: 1,
    })
    expect(await runtime.repository.findMessage(defaultMessage.id)).toBeDefined()
    expect(await runtime.repository.findMessage(shortMessage.id)).toBeUndefined()
  })

  it("removes only old stopped processes without live ownership", async () => {
    runtime = configuredRuntime({ processRetentionMilliseconds: 7 * DAY })
    await runtime.install()
    for (const processId of ["old-stopped", "owned-stopped", "recent-stopped", "running"]) {
      await runtime.repository.registerProcess(processId, "worker")
    }
    await runtime.repository.stopProcess("old-stopped")
    await runtime.repository.stopProcess("owned-stopped")
    await runtime.repository.stopProcess("recent-stopped")
    await RetentionActor.ref("owned").increment()
    await runtime.settings.database.connection(async (connection) => {
      await connection.run(
        `UPDATE ${runtime?.repository.table("processes")} SET stopped_at_ms = ? WHERE id IN (?, ?)`,
        [Date.now() - 8 * DAY, "old-stopped", "owned-stopped"],
      )
      await connection.run(
        `UPDATE ${runtime?.repository.table("processes")} SET stopped_at_ms = ? WHERE id = ?`,
        [Date.now() - DAY, "recent-stopped"],
      )
      await connection.run(
        `UPDATE ${runtime?.repository.table("instances")} SET activation_owner_id = ? WHERE actor_id = ?`,
        ["owned-stopped", "owned"],
      )
    })

    expect(await runtime.retention.preview({ target: "processes" })).toEqual({
      target: "processes",
      count: 1,
    })
    expect(await runtime.retention.prune({ target: "processes" })).toEqual({
      target: "processes",
      count: 1,
    })
    const processIds = await runtime.settings.database.connection((connection) =>
      connection.all<{ id: string }>(
        `SELECT id FROM ${runtime?.repository.table("processes")} ORDER BY id`,
      ),
    )
    const retainedProcessIds = processIds.map(({ id }) => id)
    expect(retainedProcessIds).not.toContain("old-stopped")
    expect(retainedProcessIds).toEqual(
      expect.arrayContaining(["owned-stopped", "recent-stopped", "running"]),
    )
  })

  it("expires actor instances only through opt-in policies and preserves pending work", async () => {
    runtime = configuredRuntime({
      instanceRetentionByActorType: { [RetentionActor.actorType]: 30 * DAY },
    })
    await runtime.install()
    await RetentionActor.ref("expired").increment()
    await ShortRetentionActor.ref("retained").run()
    await RetentionActor.ref("scheduled").scheduleIncrement()
    await RetentionActor.ref("pending")
      .send.with({ availableAt: new Date(Date.now() + DAY) })
      .increment()
    const oldTimestamp = Date.now() - 31 * DAY
    await runtime.settings.database.connection((connection) =>
      connection.run(`UPDATE ${runtime?.repository.table("instances")} SET updated_at_ms = ?`, [
        oldTimestamp,
      ]),
    )

    expect(await runtime.retention.preview({ target: "instances" })).toEqual({
      target: "instances",
      count: 1,
    })
    expect(await runtime.retention.prune({ target: "instances" })).toEqual({
      target: "instances",
      count: 1,
    })
    expect(
      await runtime.repository.findInstanceByIdentity(RetentionActor.actorType, "expired"),
    ).toBeUndefined()
    expect(
      await runtime.repository.findInstanceByIdentity(ShortRetentionActor.actorType, "retained"),
    ).toBeDefined()
    expect(
      await runtime.repository.findInstanceByIdentity(RetentionActor.actorType, "scheduled"),
    ).toBeDefined()
    expect(
      await runtime.repository.findInstanceByIdentity(RetentionActor.actorType, "pending"),
    ).toBeDefined()
  })
})

async function ageMessages(ids: readonly string[], completedAt: number): Promise<void> {
  await runtime?.settings.database.connection((connection) =>
    connection.run(
      `UPDATE ${runtime?.repository.table("messages")}
       SET completed_at_ms = ? WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      [completedAt, JSON.stringify(ids)],
    ),
  )
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
    ...overrides,
  })
}

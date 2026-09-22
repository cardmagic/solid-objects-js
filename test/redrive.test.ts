import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"

class PaymentActor extends Actor {
  static override readonly actorType = "RedrivePaymentActor"

  placed = 0

  place(): void {
    this.placed += 1
    this.emit("settle", { arguments: { order: "one" } })
  }

  explode(): void {
    throw new Error("poison message")
  }
}

class ShipmentActor extends Actor {
  static override readonly actorType = "RedriveShipmentActor"

  count = 0

  touch(): void {
    this.count += 1
  }

  override observables(): { count: number } {
    return { count: this.count }
  }
}

let runtime: SolidObjectsRuntime | undefined
let deliver: () => void = () => {}

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  deliver = () => {}
})

async function start(): Promise<SolidObjectsRuntime> {
  const created = configure({
    database: sqlite({ path: ":memory:" }),
    maxAttempts: 1,
    retryDelayMilliseconds: () => 0,
    redriveBatchSize: 10,
    redriveBatchPauseMilliseconds: 0,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeAdministration: () => true,
    broadcast: async () => deliver(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  })
  created.register(PaymentActor)
  created.register(ShipmentActor)
  created.registerEffect("settle", () => {
    throw new Error("declined")
  })
  await created.install()
  runtime = created
  return created
}

async function deadEffects(active: SolidObjectsRuntime, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await active.ref(PaymentActor, `order-${index}`).send.place()
  }
  await active.worker().runUntilIdle()
  await markDead(active, "effects")
  expect(await active.deadLetters.effects.all()).toHaveLength(count)
}

async function deadBroadcast(active: SolidObjectsRuntime): Promise<void> {
  await active.ref(ShipmentActor, "one").send.touch()
  await active.worker().runUntilIdle()
  await markDead(active, "broadcasts")
}

async function markDead(active: SolidObjectsRuntime, table: string): Promise<void> {
  await active.settings.database.transaction(async (connection) => {
    const now = await connection.nowMilliseconds()
    await connection.run(
      `UPDATE ${active.repository.table(table)} SET status = 'dead', failed_at_ms = ?
       WHERE status <> 'dead'`,
      [now],
    )
  })
}

async function drain(active: SolidObjectsRuntime): Promise<void> {
  while (await active.redrives.advance()) continue
}

async function pendingEffects(active: SolidObjectsRuntime): Promise<number> {
  const row = await active.settings.database.connection((connection) =>
    connection.get<{ total: number | bigint }>(
      `SELECT COUNT(*) AS total FROM ${active.repository.table("effects")} WHERE status = 'pending'`,
    ),
  )
  return Number(row?.total ?? 0)
}

describe("redrive", () => {
  it("moves every matching row in bounded batches", async () => {
    const active = await start()
    await deadEffects(active, 25)

    const task = await active.deadLetters.effects.redrive()
    expect(task.status).toBe("running")

    expect(await active.redrives.advance()).toBe(true)
    expect(await pendingEffects(active)).toBe(10)
    expect(await active.redrives.advance()).toBe(true)
    expect(await pendingEffects(active)).toBe(20)
    expect(await active.redrives.advance()).toBe(true)
    expect(await pendingEffects(active)).toBe(25)
    expect(await active.redrives.advance()).toBe(false)

    const finished = await active.redrives.find(task.id)
    expect(finished.status).toBe("completed")
    expect(finished.moved).toBe(25)
    expect(finished.remaining).toBe(0)
  })

  it("stops at the limit and leaves the rest dead", async () => {
    const active = await start()
    await deadEffects(active, 25)

    const task = await active.deadLetters.effects.redrive({ limit: 15 })
    await drain(active)

    const finished = await active.redrives.find(task.id)
    expect(finished.moved).toBe(15)
    expect(finished.status).toBe("completed")
    expect(await active.deadLetters.effects.all()).toHaveLength(10)
  })

  it("returns the running task when the same scope is redriven again", async () => {
    const active = await start()
    await deadEffects(active, 25)

    const first = await active.deadLetters.effects.redrive()
    const second = await active.deadLetters.effects.redrive()

    expect(second.id).toBe(first.id)
    expect(await active.redrives.all()).toHaveLength(1)
  })

  it("starts a separate task for another scope while one runs", async () => {
    const active = await start()
    await deadEffects(active, 5)
    await deadBroadcast(active)

    const effects = await active.deadLetters.effects.redrive()
    const broadcasts = await active.deadLetters.broadcasts.redrive()

    expect(broadcasts.id).not.toBe(effects.id)
    expect((await active.redrives.all()).map(({ kind }) => kind).sort()).toEqual([
      "broadcast",
      "effect",
    ])
  })

  it("starts a separate task for different filters", async () => {
    const active = await start()
    await deadEffects(active, 5)

    const first = await active.deadLetters.effects.redrive()
    const second = await active.deadLetters.effects.redrive({ actorType: "RedrivePaymentActor" })

    expect(second.id).not.toBe(first.id)
  })

  it("starts a new task once the first finishes", async () => {
    const active = await start()
    await deadEffects(active, 5)
    const first = await active.deadLetters.effects.redrive()
    await drain(active)
    await markDead(active, "effects")

    const second = await active.deadLetters.effects.redrive()

    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe("running")
  })

  it("cancels a running task and keeps the rows it already moved", async () => {
    const active = await start()
    await deadEffects(active, 25)
    const task = await active.deadLetters.effects.redrive()
    await active.redrives.advance()

    await task.cancel()

    expect(await active.redrives.advance()).toBe(false)
    const cancelled = await active.redrives.find(task.id)
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.moved).toBe(10)
    expect(await pendingEffects(active)).toBe(10)
    expect(await active.deadLetters.effects.all()).toHaveLength(15)
  })

  it("filters by actor type", async () => {
    const active = await start()
    await deadEffects(active, 3)

    const task = await active.deadLetters.effects.redrive({ actorType: "RedriveShipmentActor" })
    await drain(active)

    expect((await active.redrives.find(task.id)).moved).toBe(0)
    expect(await active.deadLetters.effects.all()).toHaveLength(3)
  })

  it("filters by failure time", async () => {
    const active = await start()
    await deadEffects(active, 3)

    const task = await active.deadLetters.effects.redrive({
      failedAfter: new Date(Date.now() + 60_000),
    })
    await drain(active)

    expect((await active.redrives.find(task.id)).moved).toBe(0)
  })

  it("reads tasks back by id and by status", async () => {
    const active = await start()
    await deadEffects(active, 5)
    const task = await active.deadLetters.effects.redrive()

    expect((await active.redrives.all({ status: "running" })).map(({ id }) => id)).toEqual([
      task.id,
    ])

    await drain(active)

    expect(await active.redrives.all({ status: "running" })).toHaveLength(0)
    expect((await active.redrives.all({ status: "completed" })).map(({ id }) => id)).toEqual([
      task.id,
    ])
  })

  it("reports what a running task has left to move", async () => {
    const active = await start()
    await deadEffects(active, 25)

    const task = await active.deadLetters.effects.redrive({ limit: 15 })
    expect(task.remaining).toBe(15)

    await active.redrives.advance()

    expect((await active.redrives.find(task.id)).remaining).toBe(5)
  })

  it(
    "a running runtime advances a redrive without a caller driving it",
    { timeout: 20_000 },
    async () => {
      const active = await start()
      await deadEffects(active, 12)
      const task = await active.deadLetters.effects.redrive()
      const controller = new AbortController()
      const running = active.run(controller.signal)

      const deadline = Date.now() + 10_000
      while ((await active.redrives.find(task.id)).status !== "completed") {
        if (Date.now() > deadline) throw new Error("the runtime did not finish the redrive")
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      controller.abort()
      await running

      expect((await active.redrives.find(task.id)).moved).toBe(12)
    },
  )

  it("does not move a row that died after the task started", async () => {
    const active = await start()
    await deadEffects(active, 2)
    const task = await active.deadLetters.effects.redrive()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await active.ref(PaymentActor, "late").send.place()
    await active.worker().runUntilIdle()
    await markDead(active, "effects")

    await drain(active)

    expect((await active.redrives.find(task.id)).moved).toBe(2)
    expect(await active.deadLetters.effects.all()).toHaveLength(1)
  })

  it("does not let a cancel overwrite a task the runner already finished", async () => {
    const active = await start()
    await deadEffects(active, 1)
    const task = await active.deadLetters.effects.redrive()
    await drain(active)

    await task.cancel()

    expect((await active.redrives.find(task.id)).status).toBe("completed")
    expect((await auditRows(active)).map(({ action }) => action)).toEqual([
      "redrive.start",
      "redrive.finish",
    ])
  })

  it("reports a task as a frozen value", async () => {
    const active = await start()
    await deadEffects(active, 1)

    const task = await active.deadLetters.effects.redrive()

    expect(Object.isFrozen(task)).toBe(true)
    expect(task.kind).toBe("effect")
    expect(task.startedAt).toBeInstanceOf(Date)
    expect(task.finishedAt).toBeNull()
  })

  it("refuses an invalid filter rather than redrive everything", async () => {
    const active = await start()
    await deadEffects(active, 2)

    await expect(
      active.deadLetters.effects.redrive({ failedAfter: new Date("nonsense") }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(active.deadLetters.effects.redrive({ limit: 0 })).rejects.toBeInstanceOf(TypeError)
    await expect(active.deadLetters.effects.redrive({ limit: 1.5 })).rejects.toBeInstanceOf(
      TypeError,
    )

    expect(await active.redrives.all()).toHaveLength(0)
    expect(await auditRows(active)).toHaveLength(0)
  })

  it("writes no audit row when the retry itself fails", async () => {
    const active = await start()
    await deadEffects(active, 1)
    const id = (await active.deadLetters.effects.all())[0]!.id
    const scope = active.deadLetters.effects
    const revive = vi.spyOn(scope, "revive").mockRejectedValue(new Error("injected failure"))

    await expect(scope.retry(id)).rejects.toThrow("injected failure")

    expect(await auditRows(active)).toHaveLength(0)
    revive.mockRestore()
  })

  it("writes no audit row when a message retry fails to enqueue", async () => {
    const active = await start()
    await active.ref(PaymentActor, "poison").send.explode()
    await active.worker().runUntilIdle()
    const letters = await active.deadLetters.all()
    const enqueue = vi
      .spyOn(active.repository, "enqueueInTransaction")
      .mockRejectedValue(new Error("injected failure"))

    await expect(active.deadLetters.retry(letters[0]!.id)).rejects.toThrow("injected failure")

    expect(await auditRows(active)).toHaveLength(0)
    enqueue.mockRestore()
  })

  it("writes no audit row when a retry names a row that does not exist", async () => {
    const active = await start()

    await expect(active.deadLetters.effects.retry("missing")).rejects.toThrow()

    expect(await auditRows(active)).toHaveLength(0)
  })

  it("refuses an unauthorized caller that reaches the manager directly", async () => {
    const active = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
    })
    runtime = active
    await active.install()

    await expect(
      active.redrives.start({
        kind: "effect",
        filters: { actorType: null, failedAfter: null, limit: null },
      }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })

  it("refuses an unauthorized caller", async () => {
    const active = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
    })
    runtime = active
    await active.install()

    await expect(active.deadLetters.effects.redrive()).rejects.toBeInstanceOf(Unauthorized)
    await expect(active.redrives.all()).rejects.toBeInstanceOf(Unauthorized)
    await expect(active.redrives.find("missing")).rejects.toBeInstanceOf(Unauthorized)
    await expect(active.redrives.cancel("missing")).rejects.toBeInstanceOf(Unauthorized)
  })
})

describe("administration audit", () => {
  it("writes one row for each retry, including a repeat", async () => {
    const active = await start()
    await deadEffects(active, 1)
    const id = (await active.deadLetters.effects.all())[0]!.id

    await active.deadLetters.effects.retry(id)
    await active.deadLetters.effects.retry(id)

    const events = await auditRows(active)
    expect(events.map(({ action }) => action)).toEqual(["dead_letter.retry", "dead_letter.retry"])
    expect(events[0]).toMatchObject({ kind: "effect", subject_id: id })
  })

  it("writes one row for a broadcast retry", async () => {
    const active = await start()
    await deadBroadcast(active)
    const dead = await active.deadLetters.broadcasts.all()

    await active.deadLetters.broadcasts.retry(dead[0]!.id)

    const events = await auditRows(active)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: "dead_letter.retry",
      kind: "broadcast",
      subject_id: dead[0]!.id,
    })
  })

  it("writes one row for a message retry", async () => {
    const active = await start()
    await active.ref(PaymentActor, "poison").send.explode()
    await active.worker().runUntilIdle()
    const letters = await active.deadLetters.all()
    expect(letters).toHaveLength(1)

    await active.deadLetters.retry(letters[0]!.id)

    const events = await auditRows(active)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: "dead_letter.retry",
      kind: "message",
      subject_id: letters[0]!.id,
    })
  })

  it("writes one row for each redrive transition", async () => {
    const active = await start()
    await deadEffects(active, 5)

    const task = await active.deadLetters.effects.redrive()
    await drain(active)

    const events = await auditRows(active)
    expect(events.map(({ action }) => action)).toEqual(["redrive.start", "redrive.finish"])
    expect(events.map(({ subject_id }) => subject_id)).toEqual([task.id, task.id])
  })

  it("writes one row when a task is cancelled", async () => {
    const active = await start()
    await deadEffects(active, 5)
    const task = await active.deadLetters.effects.redrive()

    await task.cancel()

    expect((await auditRows(active)).map(({ action }) => action)).toEqual([
      "redrive.start",
      "redrive.cancel",
    ])
  })

  it("records the identity the application names", async () => {
    const active = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeAdministration: () => true,
      administrationIdentity: (context) => `user:${(context as { id: number }).id}`,
    })
    runtime = active
    await active.install()

    await active.deadLetters.effects.redrive({ authorizationContext: { id: 42 } })

    expect((await auditRows(active))[0]?.actor).toBe("user:42")
  })

  it("writes no row when the caller is refused, and none for a read", async () => {
    const active = await start()
    await deadEffects(active, 1)

    await active.deadLetters.effects.all()
    expect(await auditRows(active)).toHaveLength(0)

    const refusing = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
    })
    await refusing.install()
    await expect(refusing.deadLetters.effects.retry("missing")).rejects.toBeInstanceOf(Unauthorized)
    expect(await auditRows(refusing)).toHaveLength(0)
    await refusing.close()
  })
})

async function auditRows(
  active: SolidObjectsRuntime,
): Promise<{ action: string; kind: string; subject_id: string | null; actor: string | null }[]> {
  return await active.settings.database.connection((connection) =>
    connection.all(
      `SELECT action, kind, subject_id, actor FROM
       ${active.repository.table("administration_events")} ORDER BY id`,
    ),
  )
}

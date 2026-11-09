import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { DueWork } from "../src/due-work.js"
import type { MessageRow } from "../src/records.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

const aliveThreshold = 60_000
const leaseDuration = 30_000
const tolerance = 1_000

let runtime: SolidObjectsRuntime
let dueWork: DueWork

beforeEach(async () => {
  runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    singleOwner: true,
    processAliveThresholdMilliseconds: aliveThreshold,
    leaseDurationMilliseconds: leaseDuration,
  })
  await runtime.install()
  dueWork = new DueWork(runtime.settings)
})

afterEach(async () => {
  await runtime.close()
})

function databaseNow(): Promise<number> {
  return runtime.settings.database.connection((connection) => connection.nowMilliseconds())
}

async function write(sql: string, parameters: readonly unknown[] = []): Promise<void> {
  await runtime.settings.database.transaction((connection) => connection.run(sql, parameters))
}

function enqueue(options: { actorId: string; availableAtMilliseconds?: number }) {
  return runtime.repository.enqueue({
    actorType: "Probe",
    actorId: options.actorId,
    operation: "work",
    deliveryMode: "async",
    arguments: {},
    ...(options.availableAtMilliseconds === undefined
      ? {}
      : { availableAtMilliseconds: options.availableAtMilliseconds }),
  })
}

async function registerOwner(options: {
  id: string
  heartbeatAtMilliseconds: number
  shutdownState?: "running" | "draining" | "stopped"
}): Promise<void> {
  await write(
    `INSERT INTO solid_objects_processes
     (id, kind, hostname, host_process_id, metadata, started_at_ms, heartbeat_at_ms, shutdown_state)
     VALUES (?, 'worker', 'other-host', 1, '{}', ?, ?, ?)`,
    [
      options.id,
      options.heartbeatAtMilliseconds,
      options.heartbeatAtMilliseconds,
      options.shutdownState ?? "running",
    ],
  )
}

async function insertEffect(options: {
  message: MessageRow
  id: string
  status: "pending" | "processing"
  availableAtMilliseconds: number
  claimedBy?: string
}): Promise<void> {
  await write(
    `INSERT INTO solid_objects_effects
     (id, message_id, instance_id, name, arguments, status, max_attempts, available_at_ms, claimed_by)
     VALUES (?, ?, ?, 'work', '{}', ?, 3, ?, ?)`,
    [
      options.id,
      options.message.id,
      options.message.instance_id,
      options.status,
      options.availableAtMilliseconds,
      options.claimedBy ?? null,
    ],
  )
}

async function insertReminder(options: {
  message: MessageRow
  id: string
  runAtMilliseconds: number
  status?: "scheduled" | "paused"
  claimedBy?: string
  claimedAtMilliseconds?: number
}): Promise<void> {
  await write(
    `INSERT INTO solid_objects_reminders
     (id, instance_id, operation, run_at_ms, arguments, missed_policy, status, claimed_by, claimed_at_ms)
     VALUES (?, ?, ?, ?, '{}', 'latest', ?, ?, ?)`,
    [
      options.id,
      options.message.instance_id,
      options.id,
      options.runAtMilliseconds,
      options.status ?? "scheduled",
      options.claimedBy ?? null,
      options.claimedAtMilliseconds ?? null,
    ],
  )
}

async function insertBroadcast(options: {
  message: MessageRow
  id: string
  revision: number
  status: "pending" | "processing"
  availableAtMilliseconds: number
  claimedBy?: string
}): Promise<void> {
  await write(
    `INSERT INTO solid_objects_broadcasts
     (id, message_id, instance_id, actor_type, actor_id, state_revision, observables, status,
      available_at_ms, claimed_by)
     VALUES (?, ?, ?, 'Probe', ?, ?, '{}', ?, ?, ?)`,
    [
      options.id,
      options.message.id,
      options.message.instance_id,
      options.message.actor_id,
      options.revision,
      options.status,
      options.availableAtMilliseconds,
      options.claimedBy ?? null,
    ],
  )
}

function expectAbout(actual: number | undefined, expected: number): void {
  expect(actual).toBeDefined()
  expect(actual!).toBeGreaterThan(expected - tolerance)
  expect(actual!).toBeLessThanOrEqual(expected)
}

describe("DueWork", () => {
  it("reports no due time when no work exists", async () => {
    expect(await dueWork.untilActorWork({ processId: "worker" })).toBeUndefined()
    expect(await dueWork.untilEffectWork()).toBeUndefined()
    expect(await dueWork.untilReminderWork()).toBeUndefined()
    expect(await dueWork.untilBroadcastWork()).toBeUndefined()
    expect(await dueWork.untilRedriveWork()).toBeUndefined()
  })

  describe("actor work", () => {
    it("reports the earliest ready message", async () => {
      const now = await databaseNow()
      await enqueue({ actorId: "late", availableAtMilliseconds: now + 9_000 })
      await enqueue({ actorId: "early", availableAtMilliseconds: now + 5_000 })

      expectAbout(await dueWork.untilActorWork({ processId: "worker" }), 5_000)
    })

    it("waits for the head of a mailbox, not for a later message behind it", async () => {
      const now = await databaseNow()
      await enqueue({ actorId: "blocked", availableAtMilliseconds: now + 8_000 })
      await enqueue({ actorId: "blocked" })

      expectAbout(await dueWork.untilActorWork({ processId: "worker" }), 8_000)
    })

    it("skips a paused actor", async () => {
      const message = await enqueue({ actorId: "paused" })
      await write("UPDATE solid_objects_instances SET paused = 1 WHERE id = ?", [
        message.instance_id,
      ])

      expect(await dueWork.untilActorWork({ processId: "worker" })).toBeUndefined()
    })

    it("waits for an activation that another owner holds", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "held" })
      await registerOwner({ id: "holder", heartbeatAtMilliseconds: now })
      await write(
        `UPDATE solid_objects_instances
         SET activation_owner_id = 'holder', activation_token = 'token', activation_expires_at_ms = ?
         WHERE id = ?`,
        [now + 7_000, message.instance_id],
      )

      expectAbout(await dueWork.untilActorWork({ processId: "worker" }), 7_000)
    })

    it("reports a message at its available time to the worker that holds the activation", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "held", availableAtMilliseconds: now + 5_000 })
      await registerOwner({ id: "holder", heartbeatAtMilliseconds: now })
      await write(
        `UPDATE solid_objects_instances
         SET activation_owner_id = 'holder', activation_token = 'token', activation_expires_at_ms = ?
         WHERE id = ?`,
        [now + leaseDuration, message.instance_id],
      )

      expectAbout(await dueWork.untilActorWork({ processId: "holder" }), 5_000)
      expectAbout(await dueWork.untilActorWork({ processId: "other" }), leaseDuration)
    })

    it("waits for the lease of a claimed message to expire", async () => {
      const now = await databaseNow()
      await enqueue({ actorId: "claimed" })
      await registerOwner({ id: "claimer", heartbeatAtMilliseconds: now })
      expect(await runtime.repository.claim("claimer")).toBeDefined()

      expectAbout(await dueWork.untilActorWork({ processId: "worker" }), leaseDuration)
    })
  })

  describe("effect work", () => {
    it("reports a pending effect at its available time", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "effects" })
      await insertEffect({
        message,
        id: "retry",
        status: "pending",
        availableAtMilliseconds: now + 4_000,
      })

      expectAbout(await dueWork.untilEffectWork(), 4_000)
    })

    it("reports a processing effect when its owner becomes stale", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "effects" })
      await registerOwner({ id: "owner", heartbeatAtMilliseconds: now })
      await insertEffect({
        message,
        id: "running",
        status: "processing",
        availableAtMilliseconds: now,
        claimedBy: "owner",
      })

      expectAbout(await dueWork.untilEffectWork(), aliveThreshold)
    })

    it.each(["missing", "draining"] as const)(
      "reports a processing effect at once when its owner is %s",
      async (owner) => {
        const now = await databaseNow()
        const message = await enqueue({ actorId: "effects" })
        if (owner === "draining") {
          await registerOwner({ id: owner, heartbeatAtMilliseconds: now, shutdownState: owner })
        }
        await insertEffect({
          message,
          id: "orphan",
          status: "processing",
          availableAtMilliseconds: now,
          claimedBy: owner,
        })

        expect(await dueWork.untilEffectWork()).toBeLessThanOrEqual(0)
      },
    )

    it("uses the longer recovery timeout of an effect with a recovery operation", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "effects" })
      await registerOwner({ id: "owner", heartbeatAtMilliseconds: now, shutdownState: "stopped" })
      await insertEffect({
        message,
        id: "recoverable",
        status: "processing",
        availableAtMilliseconds: now,
        claimedBy: "owner",
      })
      await write(
        `INSERT INTO solid_objects_effect_recoveries
         (effect_id, instance_id, recovery_operation, status_operation, recovery_timeout_ms)
         VALUES ('recoverable', ?, 'recover', 'inspect', ?)`,
        [message.instance_id, 120_000],
      )

      expectAbout(await dueWork.untilEffectWork(), 120_000)
    })
  })

  describe("reminder work", () => {
    it("reports a scheduled reminder at its run time and skips a paused one", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "reminders" })
      await insertReminder({ message, id: "paused", runAtMilliseconds: now, status: "paused" })
      await insertReminder({ message, id: "later", runAtMilliseconds: now + 3_000 })

      expectAbout(await dueWork.untilReminderWork(), 3_000)
    })

    it("reports a claimed reminder when its claim becomes stale", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "reminders" })
      await registerOwner({ id: "scheduler", heartbeatAtMilliseconds: now + 10_000 })
      await insertReminder({
        message,
        id: "claimed",
        runAtMilliseconds: now - 1_000,
        claimedBy: "scheduler",
        claimedAtMilliseconds: now,
      })

      expectAbout(await dueWork.untilReminderWork(), aliveThreshold)
    })

    it("reports a reminder at its run time when its claim owner is gone", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "reminders" })
      await insertReminder({
        message,
        id: "orphan",
        runAtMilliseconds: now + 2_000,
        claimedBy: "missing",
        claimedAtMilliseconds: now,
      })

      expectAbout(await dueWork.untilReminderWork(), 2_000)
    })
  })

  describe("broadcast work", () => {
    it("waits for the earliest revision of an actor, not for a later one behind it", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "broadcasts" })
      await insertBroadcast({
        message,
        id: "first",
        revision: 1,
        status: "pending",
        availableAtMilliseconds: now + 6_000,
      })
      await insertBroadcast({
        message,
        id: "second",
        revision: 2,
        status: "pending",
        availableAtMilliseconds: now,
      })

      expectAbout(await dueWork.untilBroadcastWork(), 6_000)
    })

    it("reports a processing broadcast when its owner becomes stale", async () => {
      const now = await databaseNow()
      const message = await enqueue({ actorId: "broadcasts" })
      await registerOwner({ id: "owner", heartbeatAtMilliseconds: now })
      await insertBroadcast({
        message,
        id: "running",
        revision: 1,
        status: "processing",
        availableAtMilliseconds: now,
        claimedBy: "owner",
      })

      expectAbout(await dueWork.untilBroadcastWork(), aliveThreshold)
    })
  })

  describe("redrive work", () => {
    it("reports a running redrive as due now", async () => {
      const now = await databaseNow()
      await write(
        `INSERT INTO solid_objects_redrives (id, kind, filters, status, started_at_ms)
         VALUES ('redrive', 'effect', '{}', 'running', ?)`,
        [now],
      )

      expect(await dueWork.untilRedriveWork()).toBe(0)
    })
  })
})

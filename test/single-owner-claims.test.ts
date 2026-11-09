import { afterEach, describe, expect, it } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import type { MessageRow } from "../src/records.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

const aliveThreshold = 60_000
const idleAge = 2 * aliveThreshold

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

async function installedRuntime(options: { singleOwner: boolean }): Promise<SolidObjectsRuntime> {
  runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    singleOwner: options.singleOwner,
    processAliveThresholdMilliseconds: aliveThreshold,
    authorizeAdministration: () => true,
  })
  await runtime.install()
  return runtime
}

async function write(sql: string, parameters: readonly unknown[] = []): Promise<void> {
  await runtime!.settings.database.transaction((connection) => connection.run(sql, parameters))
}

async function registerIdleWorker(options: { id: string; kind: string }): Promise<void> {
  await runtime!.repository.registerProcess(options.id, options.kind)
  await write(
    "UPDATE solid_objects_processes SET heartbeat_at_ms = heartbeat_at_ms - ? WHERE id = ?",
    [idleAge, options.id],
  )
}

async function processRow(id: string) {
  return runtime!.settings.database.connection(async (connection) => ({
    now: await connection.nowMilliseconds(),
    row: await connection.get<{ heartbeat_at_ms: number | bigint; shutdown_state: string }>(
      "SELECT heartbeat_at_ms, shutdown_state FROM solid_objects_processes WHERE id = ?",
      [id],
    ),
  }))
}

function enqueue(actorId: string): Promise<MessageRow> {
  return runtime!.repository.enqueue({
    actorType: "Probe",
    actorId,
    operation: "work",
    deliveryMode: "async",
    arguments: {},
  })
}

async function seedEffect(options: { recoverable: boolean }): Promise<void> {
  const message = await enqueue("effects")
  await write(
    `INSERT INTO solid_objects_effects
     (id, message_id, instance_id, name, arguments, status, max_attempts, available_at_ms)
     VALUES ('effect', ?, ?, 'work', '{}', 'pending', 3, 0)`,
    [message.id, message.instance_id],
  )
  if (!options.recoverable) return
  await write(
    `INSERT INTO solid_objects_effect_recoveries
     (effect_id, instance_id, recovery_operation, status_operation)
     VALUES ('effect', ?, 'recover', 'inspect')`,
    [message.instance_id],
  )
}

async function effectState() {
  return runtime!.settings.database.connection((connection) =>
    connection.get<{ status: string; claimed_by: string | null }>(
      "SELECT status, claimed_by FROM solid_objects_effects WHERE id = 'effect'",
    ),
  )
}

describe("a singleOwner claim", () => {
  it("refreshes the process row of a worker that was idle, in the claim transaction", async () => {
    await installedRuntime({ singleOwner: true })
    await registerIdleWorker({ id: "idle", kind: "effect_worker" })
    await write("UPDATE solid_objects_processes SET shutdown_state = 'stopped' WHERE id = 'idle'")
    await seedEffect({ recoverable: false })

    expect(await runtime!.repository.claimEffect("idle")).toBeDefined()

    const { now, row } = await processRow("idle")
    expect(row?.shutdown_state).toBe("running")
    expect(Number(row?.heartbeat_at_ms)).toBeGreaterThan(now - 1_000)
  })

  it("keeps an effect from a second worker after the first worker was idle", async () => {
    await installedRuntime({ singleOwner: true })
    await registerIdleWorker({ id: "first", kind: "effect_worker" })
    await runtime!.repository.registerProcess("second", "effect_worker")
    await seedEffect({ recoverable: false })

    expect(await runtime!.repository.claimEffect("first")).toBeDefined()
    expect(await runtime!.repository.claimEffect("second")).toBeUndefined()

    expect(await effectState()).toEqual({ status: "processing", claimed_by: "first" })
  })

  it("keeps a running effect with a recovery operation from being retired", async () => {
    await installedRuntime({ singleOwner: true })
    await registerIdleWorker({ id: "first", kind: "effect_worker" })
    await seedEffect({ recoverable: true })

    expect(await runtime!.repository.claimEffect("first")).toBeDefined()
    await runtime!.processes.cleanup()

    expect(await effectState()).toEqual({ status: "processing", claimed_by: "first" })
  })

  it("keeps a claimed message from the process cleanup", async () => {
    await installedRuntime({ singleOwner: true })
    await registerIdleWorker({ id: "first", kind: "worker" })
    await enqueue("actor")

    expect(await runtime!.repository.claim("first")).toBeDefined()

    expect(await runtime!.processes.cleanup()).toEqual({ cleaned: 0 })
  })

  it("keeps a reminder from a second scheduler after the first was idle", async () => {
    await installedRuntime({ singleOwner: true })
    await registerIdleWorker({ id: "first", kind: "reminder_scheduler" })
    await runtime!.repository.registerProcess("second", "reminder_scheduler")
    const message = await enqueue("reminders")
    await write(
      `INSERT INTO solid_objects_reminders
       (id, instance_id, operation, run_at_ms, arguments, missed_policy, status)
       VALUES ('reminder', ?, 'work', 0, '{}', 'latest', 'scheduled')`,
      [message.instance_id],
    )

    expect(await runtime!.repository.claimReminder("first")).toBeDefined()
    expect(await runtime!.repository.claimReminder("second")).toBeUndefined()
  })

  it("keeps a broadcast from a second worker after the first was idle", async () => {
    await installedRuntime({ singleOwner: true })
    await registerIdleWorker({ id: "first", kind: "broadcast_worker" })
    await runtime!.repository.registerProcess("second", "broadcast_worker")
    const message = await enqueue("broadcasts")
    await write(
      `INSERT INTO solid_objects_broadcasts
       (id, message_id, instance_id, actor_type, actor_id, state_revision, observables, status,
        available_at_ms)
       VALUES ('broadcast', ?, ?, 'Probe', 'broadcasts', 1, '{}', 'pending', 0)`,
      [message.id, message.instance_id],
    )

    expect(await runtime!.repository.claimBroadcast("first")).toBeDefined()
    expect(await runtime!.repository.claimBroadcast("second")).toBeUndefined()
  })

  it("leaves the process row alone without the option", async () => {
    await installedRuntime({ singleOwner: false })
    await registerIdleWorker({ id: "idle", kind: "effect_worker" })
    const before = await processRow("idle")
    await seedEffect({ recoverable: false })

    expect(await runtime!.repository.claimEffect("idle")).toBeDefined()

    const after = await processRow("idle")
    expect(after.row?.heartbeat_at_ms).toBe(before.row?.heartbeat_at_ms)
  })
})

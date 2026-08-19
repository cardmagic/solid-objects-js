import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { VERSION } from "../src/version.js"

class ProcessActor extends Actor {
  static override readonly actorType = "ProcessActor"

  run(): void {}
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("process administration", () => {
  it("authorizes inspection before reading process records", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => false })
    await runtime.install()
    await runtime.repository.registerProcess("hidden", "worker")

    await expect(runtime.processes.all()).rejects.toBeInstanceOf(Unauthorized)
  })

  it("authorizes the administration process query", async () => {
    runtime = configuredRuntime({ authorizeAdministration: () => false })
    await runtime.install()

    await expect(runtime.administration.processes()).rejects.toBeInstanceOf(Unauthorized)
  })

  it("returns immutable process metadata with current liveness", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await runtime.repository.registerProcess("live", "worker")
    await runtime.repository.registerProcess("stale", "effect_worker")
    await staleProcess("stale")

    const processes = await runtime.processes.all()

    expect(processes).toHaveLength(2)
    expect(processes.find(({ id }) => id === "live")).toMatchObject({
      kind: "worker",
      hostname: expect.any(String),
      hostProcessId: process.pid,
      metadata: {
        nodeVersion: process.version,
        solidObjectsVersion: VERSION,
      },
      shutdownState: "running",
      shutdownRequestedAt: null,
      stale: false,
    })
    expect(processes.find(({ id }) => id === "stale")).toMatchObject({
      kind: "effect_worker",
      shutdownState: "running",
      stale: true,
    })
    expect(Object.isFrozen(processes)).toBe(true)
    expect(processes.every(Object.isFrozen)).toBe(true)
    expect(processes.every(({ metadata }) => Object.isFrozen(metadata))).toBe(true)
  })

  it("exposes process liveness through the administration query", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await runtime.repository.registerProcess("live", "worker")

    const processes = await runtime.administration.processes()

    expect(processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "live",
          kind: "worker",
          stale: false,
        }),
      ]),
    )
  })

  it("atomically releases every claim owned by a stale process", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const message = await claimEveryRole("stale")
    await staleProcess("stale")

    const result = await runtime.processes.cleanup()

    expect(result.cleaned).toBe(1)
    await expectOwnershipReleased("stale", message)
  })

  it("atomically releases every claim during graceful shutdown", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const message = await claimEveryRole("stopping")

    await runtime.repository.stopProcess("stopping")

    await expectOwnershipReleased("stopping", message)
  })

  it("recovers a stale draining process", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const message = await claimEveryRole("draining")
    await runtime.repository.startDrainingProcess("draining")
    await staleProcess("draining")

    expect(await runtime.processes.all()).toEqual([
      expect.objectContaining({
        id: "draining",
        shutdownState: "draining",
        shutdownRequestedAt: expect.any(Date),
        stale: true,
      }),
    ])
    expect(await runtime.processes.cleanup()).toEqual({ cleaned: 1 })
    await expectOwnershipReleased("draining", message)
  })

  it("leaves live process ownership unchanged", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const message = await ProcessActor.ref("live").send.run()
    await runtime.repository.registerProcess("live", "worker")
    await runtime.repository.claim("live")

    expect(await runtime.processes.cleanup()).toEqual({ cleaned: 0 })
    expect(await message.status()).toBe("claimed")
  })
})

function configuredRuntime(
  overrides: { authorizeAdministration?: () => boolean } = {},
): SolidObjectsRuntime {
  runtime = configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    processAliveThresholdMilliseconds: 100,
    ...overrides,
  })
  runtime.register(ProcessActor)
  return runtime
}

async function staleProcess(id: string): Promise<void> {
  await runtime?.settings.database.connection((connection) =>
    connection.run(
      `UPDATE ${runtime?.repository.table("processes")} SET heartbeat_at_ms = 0 WHERE id = ?`,
      [id],
    ),
  )
}

async function claimEveryRole(processId: string) {
  const message = await ProcessActor.ref(`claimed-${processId}`).send.run()
  await runtime?.repository.registerProcess(processId, "worker")
  const turn = await runtime?.repository.claim(processId)
  expect(turn?.message.id).toBe(message.id)
  await runtime?.settings.database.connection(async (connection) => {
    await connection.run(
      `INSERT INTO ${runtime?.repository.table("effects")}
       (id, message_id, instance_id, name, arguments, status, max_attempts, available_at_ms, claimed_by)
       VALUES (?, ?, ?, 'test', '{}', 'processing', 1, 0, ?)`,
      [`effect-${processId}`, message.id, turn?.instance.id, processId],
    )
    await connection.run(
      `INSERT INTO ${runtime?.repository.table("reminders")}
       (id, instance_id, operation, run_at_ms, arguments, missed_policy, status, claimed_by,
        claimed_at_ms)
       VALUES (?, ?, 'run', 0, '{}', 'latest', 'scheduled', ?, 0)`,
      [`reminder-${processId}`, turn?.instance.id, processId],
    )
    await connection.run(
      `INSERT INTO ${runtime?.repository.table("broadcasts")}
       (id, message_id, instance_id, actor_type, actor_id, state_revision, observables,
        status, available_at_ms, claimed_by)
       VALUES (?, ?, ?, ?, 'claimed', 1, '{}', 'processing', 0, ?)`,
      [`broadcast-${processId}`, message.id, turn?.instance.id, ProcessActor.actorType, processId],
    )
  })
  return message
}

async function expectOwnershipReleased(
  processId: string,
  message: Awaited<ReturnType<typeof claimEveryRole>>,
) {
  expect(await message.status()).toBe("ready")
  const rows = await runtime?.settings.database.connection(async (connection) => ({
    process: await connection.get<{ shutdown_state: string }>(
      `SELECT shutdown_state FROM ${runtime?.repository.table("processes")} WHERE id = ?`,
      [processId],
    ),
    instance: await connection.get<{ activation_owner_id: string | null }>(
      `SELECT activation_owner_id FROM ${runtime?.repository.table("instances")} WHERE actor_id = ?`,
      [`claimed-${processId}`],
    ),
    effect: await connection.get<{ status: string; claimed_by: string | null }>(
      `SELECT status, claimed_by FROM ${runtime?.repository.table("effects")} WHERE id = ?`,
      [`effect-${processId}`],
    ),
    reminder: await connection.get<{ claimed_by: string | null }>(
      `SELECT claimed_by FROM ${runtime?.repository.table("reminders")} WHERE id = ?`,
      [`reminder-${processId}`],
    ),
    broadcast: await connection.get<{ status: string; claimed_by: string | null }>(
      `SELECT status, claimed_by FROM ${runtime?.repository.table("broadcasts")} WHERE id = ?`,
      [`broadcast-${processId}`],
    ),
  }))
  expect(rows?.process?.shutdown_state).toBe("stopped")
  expect(rows?.instance?.activation_owner_id).toBeNull()
  expect(rows?.effect).toEqual({ status: "pending", claimed_by: null })
  expect(rows?.reminder?.claimed_by).toBeNull()
  expect(rows?.broadcast).toEqual({ status: "pending", claimed_by: null })
}

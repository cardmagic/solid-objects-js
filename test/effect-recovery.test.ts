import { afterEach, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"
import { postgresql } from "../src/database/postgresql.js"
import { mysql } from "../src/database/mysql.js"
import type {
  EffectHandle,
  EffectSuccessPayload,
  EffectFailurePayload,
  JsonObject,
} from "../src/types.js"
import type { EffectRecoveryPayload, EffectRetiredPayload } from "../src/effect-recovery.js"
import { LostActivation } from "../src/errors.js"
import { EffectRecoveryCoordinator } from "../src/effect-recovery-coordinator.js"
import type { DatabaseConnection } from "../src/database/types.js"
import type { EffectRow } from "../src/records.js"

class ReportExport extends Actor {
  static override readonly actorType = "ReportExport"
  exportEffect: EffectHandle | null = null
  notifications: JsonObject[] = []

  start(): void {
    this.exportEffect = this.emit("build_report", { arguments: { revision: 1 } }) ?? null
  }

  startRecoverable({ timeoutMilliseconds }: { timeoutMilliseconds?: number } = {}): void {
    this.exportEffect = this.emit("build_report", {
      arguments: { revision: 1 },
      onRecovery: "recover",
      onStatus: "inspect",
      onSuccess: "finished",
      onFailure: "failed",
      ...(timeoutMilliseconds === undefined
        ? {}
        : { recoveryTimeoutMilliseconds: timeoutMilliseconds }),
    })
  }

  check(): void {
    if (this.exportEffect) this.requestEffectRecovery(this.exportEffect)
  }
  recover(payload: EffectRetiredPayload): void {
    this.notifications.push({ kind: "recovery", ...payload })
  }
  inspect(payload: EffectRecoveryPayload): void {
    this.notifications.push({ kind: "status", ...payload })
  }
  finished(payload: EffectSuccessPayload): void {
    this.notifications.push({ kind: "success", ...payload })
  }
  failed(payload: EffectFailurePayload): void {
    this.notifications.push({ kind: "failure", ...payload })
  }
}

let runtime: SolidObjectsRuntime | undefined
afterEach(async () => {
  await runtime?.repository.resetForTesting()
  await runtime?.close()
})

it("returns the same effect identity that the scheduler claims", async () => {
  runtime = await createTestRuntime()
  await runtime.ref(ReportExport, "export").start()
  const effect = await runtime.settings.database.connection((connection) =>
    connection.get<{ id: string }>(`SELECT id FROM ${runtime!.repository.table("effects")}`),
  )
  expect(await runtime.ref(ReportExport, "export").exportEffect).toEqual({ id: effect!.id })
})

it("retires abandoned processing effects before the scheduler can reclaim them", async () => {
  runtime = await createTestRuntime()
  await runtime.ref(ReportExport, "export").startRecoverable()
  await runtime.repository.registerProcess("owner", "effect")
  const effect = await runtime.repository.claimEffect("owner")
  await runtime.settings.database.connection((connection) =>
    connection.run(
      `UPDATE ${runtime!.repository.table("processes")} SET heartbeat_at_ms = 0 WHERE id = ?`,
      ["owner"],
    ),
  )
  await runtime.repository.registerProcess("replacement", "effect")
  expect(await runtime.repository.claimEffect("replacement")).toBeUndefined()
  const notifications = await runtime.settings.database.connection((connection) =>
    connection.all<{ arguments: string }>(
      `SELECT arguments FROM ${runtime!.repository.table("messages")} WHERE operation = 'recover'`,
    ),
  )
  expect(notifications.map((row) => JSON.parse(row.arguments))).toEqual([
    { effectId: effect!.id, arguments: { revision: 1 }, outcome: "retired" },
  ])
})

it("defers indefinitely for a fresh heartbeat without consuming an attempt", async () => {
  const effect = await processingEffect()
  await runtime!.settings.database.connection((connection) =>
    connection.run(
      `UPDATE ${runtime!.repository.table("effects")} SET available_at_ms = 0 WHERE id = ?`,
      [effect.id],
    ),
  )
  await runtime!.ref(ReportExport, "export").check()
  await runtime!.worker().runUntilIdle()
  expect(await runtime!.ref(ReportExport, "export").notifications).toEqual([
    { kind: "status", effectId: effect.id, arguments: { revision: 1 }, outcome: "deferred" },
  ])
  expect(await storedEffect(effect.id)).toMatchObject({
    status: "processing",
    claimed_by: "owner",
    attempt_count: 1n,
  })
})

it("preserves a longer grace after ordinary cleanup stops the owner", async () => {
  const effect = await processingEffect({ timeoutMilliseconds: 120_000 })
  await ageOwner(75_000)
  await runtime!.repository.cleanupStaleProcesses()
  expect(await storedEffect(effect.id)).toMatchObject({ status: "processing", claimed_by: "owner" })
  expect(await runtime!.repository.claimEffect("owner")).toBeUndefined()
  await ageOwner(125_000)
  expect(await runtime!.repository.claimEffect("owner")).toBeUndefined()
  expect(await messages("recover")).toHaveLength(1)
})

it("keeps pending retries with the existing scheduler", async () => {
  const effect = await processingEffect()
  await runtime!.repository.failEffect({ effect, error: new Error("retry"), retryable: true })
  await runtime!.ref(ReportExport, "export").check()
  expect((await messages("inspect"))[0]).toMatchObject({ effectId: effect.id, outcome: "pending" })
  expect(await storedEffect(effect.id)).toMatchObject({ status: "pending", attempt_count: 1n })
  expect(await messages("recover")).toHaveLength(0)
})

it("returns recorded null results and preserves the normal success callback", async () => {
  const effect = await processingEffect()
  await runtime!.repository.completeEffect(effect, null)
  await runtime!.ref(ReportExport, "export").check()
  expect(await messages("inspect")).toEqual([
    { effectId: effect.id, arguments: { revision: 1 }, outcome: "completed", result: null },
  ])
  expect(await messages("finished")).toEqual([
    { effectId: effect.id, arguments: { revision: 1 }, result: null },
  ])
  expect(await messages("recover")).toHaveLength(0)
})

it("preserves dead effects and their failure callbacks", async () => {
  const effect = await processingEffect()
  await runtime!.repository.failEffect({ effect, error: new Error("terminal"), retryable: false })
  await runtime!.ref(ReportExport, "export").check()
  expect((await messages("inspect"))[0]).toMatchObject({ outcome: "dead" })
  expect(await messages("failed")).toHaveLength(1)
  expect(await messages("recover")).toHaveLength(0)
})

it("deduplicates retirement across repeated checks and fences late completion and failure", async () => {
  const effect = await processingEffect()
  await ageOwner(70_000)
  await runtime!.ref(ReportExport, "export").check()
  await runtime!.ref(ReportExport, "export").check()
  expect(await messages("recover")).toHaveLength(1)
  expect((await messages("inspect")).map((payload) => payload.outcome)).toEqual([
    "retired",
    "alreadyRetired",
  ])
  await expect(runtime!.repository.completeEffect(effect, "late")).rejects.toBeInstanceOf(
    LostActivation,
  )
  await expect(
    runtime!.repository.failEffect({ effect, error: new Error("late"), retryable: true }),
  ).rejects.toBeInstanceOf(LostActivation)
  await expect(
    runtime!.repository.failEffect({ effect, error: new Error("late"), retryable: false }),
  ).rejects.toBeInstanceOf(LostActivation)
  expect(await messages("finished")).toHaveLength(0)
  expect(await messages("failed")).toHaveLength(0)
})

it("rolls back retirement if the second mailbox insert fails", async () => {
  const effect = await processingEffect()
  await ageOwner(70_000)
  const coordinator = new EffectRecoveryCoordinator({
    settings: runtime!.settings,
    enqueue: (connection, input) => {
      if (input.operation === "inspect") throw new Error("injected second insert failure")
      return runtime!.repository.enqueueInTransaction(connection, input)
    },
  })
  await expect(
    runtime!.settings.database.transaction(async (connection) => {
      const origin = await lockOrigin({ connection, effect })
      await coordinator.check({
        connection,
        origin,
        intents: [{ effectId: effect.id, requestId: "rollback" }],
      })
    }),
  ).rejects.toThrow("injected second insert failure")
  expect(await storedEffect(effect.id)).toMatchObject({ status: "processing", claimed_by: "owner" })
  expect(await messages("recover")).toHaveLength(0)
  await runtime!.ref(ReportExport, "export").check()
  expect((await messages("inspect"))[0]).toMatchObject({ outcome: "retired" })
})

it("reports missing from the owned binding without exposing another actor", async () => {
  const effect = await processingEffect()
  await runtime!.settings.database.connection((connection) =>
    connection.run(`DELETE FROM ${runtime!.repository.table("effects")} WHERE id = ?`, [effect.id]),
  )
  await runtime!.ref(ReportExport, "export").check()
  expect(await messages("inspect")).toEqual([{ effectId: effect.id, outcome: "missing" }])
  const coordinator = new EffectRecoveryCoordinator({
    settings: runtime!.settings,
    enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
  })
  await expect(
    runtime!.settings.database.transaction((connection) =>
      coordinator.check({
        connection,
        origin: { id: "foreign", actor_type: "ReportExport", actor_id: "foreign" },
        intents: [{ effectId: effect.id, requestId: "foreign" }],
      }),
    ),
  ).rejects.toThrow("owned handle")
})

async function createTestRuntime(): Promise<SolidObjectsRuntime> {
  const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
  const database = connectionString?.startsWith("postgresql:")
    ? postgresql({ connectionString, maximumConnections: 8 })
    : connectionString?.startsWith("mysql:")
      ? mysql({ connectionString })
      : sqlite({ path: ":memory:" })
  const created = createRuntime({
    database,
    tableNamePrefix: "recovery_test_",
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    maxAttempts: 2,
    retryDelayMilliseconds: () => 60_000,
  })
  created.register(ReportExport)
  await created.install()
  await created.repository.resetForTesting()
  return created
}

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "locks the origin before the effect when completion races retirement",
  async () => {
    const effect = await processingEffect()
    await ageOwner(70_000)
    const coordinator = new EffectRecoveryCoordinator({
      settings: runtime!.settings,
      enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
    })
    let completion: Promise<unknown> = Promise.resolve()
    await runtime!.settings.database.transaction(async (connection) => {
      const origin = await lockOrigin({ connection, effect })
      const process = await connection.get<{ id: number }>("SELECT pg_backend_pid() AS id")
      completion = runtime!.repository
        .completeEffect(effect, "late")
        .catch((error: unknown) => error)
      await waitForBlockedTransaction({ connection, processId: process!.id })
      await coordinator.check({
        connection,
        origin,
        intents: [{ effectId: effect.id, requestId: "lock-order" }],
      })
    })
    expect(await completion).toBeInstanceOf(LostActivation)
    expect(await messages("recover")).toHaveLength(1)
    expect(await messages("finished")).toHaveLength(0)
  },
)

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "rechecks a refreshed heartbeat after waiting for the owner lock",
  async () => {
    const effect = await processingEffect()
    await ageOwner(70_000)
    const coordinator = new EffectRecoveryCoordinator({
      settings: runtime!.settings,
      enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
    })
    let recovery: Promise<void> = Promise.resolve()
    await runtime!.settings.database.transaction(async (connection) => {
      await connection.get(
        `SELECT id FROM ${runtime!.repository.table("processes")} WHERE id = 'owner' FOR UPDATE`,
      )
      const process = await connection.get<{ id: number }>("SELECT pg_backend_pid() AS id")
      recovery = coordinator.recoverAvailable()
      await waitForBlockedTransaction({ connection, processId: process!.id })
      await connection.run(
        `UPDATE ${runtime!.repository.table("processes")} SET heartbeat_at_ms = ? WHERE id = 'owner'`,
        [await connection.nowMilliseconds()],
      )
    })
    await recovery
    expect(await storedEffect(effect.id)).toMatchObject({
      status: "processing",
      claimed_by: "owner",
    })
    expect(await messages("recover")).toHaveLength(0)
  },
)

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "two blocked automatic recovery passes enqueue one durable callback",
  async () => {
    const effect = await processingEffect()
    await ageOwner(70_000)
    const coordinator = new EffectRecoveryCoordinator({
      settings: runtime!.settings,
      enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
    })
    let recoveries: Promise<void[]> = Promise.resolve([])
    await runtime!.settings.database.transaction(async (connection) => {
      await lockOrigin({ connection, effect })
      const process = await connection.get<{ id: number }>("SELECT pg_backend_pid() AS id")
      recoveries = Promise.all([coordinator.recoverAvailable(), coordinator.recoverAvailable()])
      await waitForBlockedTransaction({ connection, processId: process!.id, count: 2 })
    })
    await recoveries
    expect(await messages("recover")).toHaveLength(1)
    await runtime!.worker().runUntilIdle()
    expect(
      (await runtime!.ref(ReportExport, "export").notifications).filter(
        (payload) => payload.kind === "recovery",
      ),
    ).toHaveLength(1)
  },
)

async function waitForBlockedTransaction(options: {
  connection: DatabaseConnection
  processId: number
  count?: number
}): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    await options.connection.get("SELECT pg_stat_clear_snapshot()")
    const row = await options.connection.get<{ count: string }>(
      "WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid)) UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))) SELECT count(*)::text AS count FROM blocked",
      [options.processId],
    )
    if (Number(row!.count) >= (options.count ?? 1)) return
  }
  throw new Error("transaction did not reach the lock barrier")
}

async function processingEffect(
  options: { timeoutMilliseconds?: number } = {},
): Promise<EffectRow> {
  runtime = await createTestRuntime()
  await runtime.ref(ReportExport, "export").startRecoverable(options)
  await runtime.repository.registerProcess("owner", "effect")
  const effect = await runtime.repository.claimEffect("owner")
  if (!effect) throw new Error("expected a processing effect")
  return effect
}

async function ageOwner(milliseconds: number): Promise<void> {
  await runtime!.settings.database.connection(async (connection) => {
    const now = await connection.nowMilliseconds()
    await connection.run(
      `UPDATE ${runtime!.repository.table("processes")} SET heartbeat_at_ms = ? WHERE id = ?`,
      [now - milliseconds, "owner"],
    )
  })
}

function storedEffect(id: string): Promise<EffectRow | undefined> {
  return runtime!.settings.database.connection((connection) =>
    connection.get<EffectRow>(
      `SELECT * FROM ${runtime!.repository.table("effects")} WHERE id = ?`,
      [id],
    ),
  )
}

async function messages(operation: string): Promise<JsonObject[]> {
  const rows = await runtime!.settings.database.connection((connection) =>
    connection.all<{ arguments: string }>(
      `SELECT arguments FROM ${runtime!.repository.table("messages")} WHERE operation = ? ORDER BY sequence`,
      [operation],
    ),
  )
  return rows.map((row) => JSON.parse(row.arguments))
}

async function lockOrigin(options: {
  connection: DatabaseConnection
  effect: EffectRow
}): Promise<{ id: string; actor_type: string; actor_id: string }> {
  const origin = await options.connection.get<{ id: string; actor_type: string; actor_id: string }>(
    `SELECT id, actor_type, actor_id FROM ${runtime!.repository.table("instances")} WHERE id = ?${runtime!.settings.database.family === "sqlite" ? "" : " FOR UPDATE"}`,
    [options.effect.instance_id],
  )
  if (!origin) throw new Error("origin missing")
  return origin
}

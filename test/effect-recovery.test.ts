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
import { LostActivation, MailboxFull } from "../src/errors.js"
import { EffectRecoveryCoordinator } from "../src/effect-recovery-coordinator.js"
import type { DatabaseConnection } from "../src/database/types.js"
import type { EffectRow } from "../src/records.js"
import { Repository } from "../src/repository.js"
import { PausingClaimDatabase } from "./support/pausing-claim-database.js"
import { deferred } from "./support/fenced-commit.js"

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

  startStatusOnly(): void {
    this.exportEffect = this.emit("build_report", {
      arguments: { revision: 1 },
      onStatus: "inspect",
    })
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
  runtime = undefined
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
  const wakeUp = await runtime.settings.wakeUp.watch("actors")
  expect(await runtime.repository.claimEffect("replacement")).toBeUndefined()
  expect(await wakeUp.wait({ timeoutMilliseconds: 0 })).toBe(true)
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
  })
  expect(Number((await storedEffect(effect.id))!.attempt_count)).toBe(1)
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
  expect(await storedEffect(effect.id)).toMatchObject({ status: "pending" })
  expect(Number((await storedEffect(effect.id))!.attempt_count)).toBe(1)
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

it("rolls back both callbacks when only one mailbox slot remains", async () => {
  const effect = await processingEffect()
  await ageOwner(70_000)
  runtime!.settings.maxMailboxLength = 1
  const coordinator = new EffectRecoveryCoordinator({
    settings: runtime!.settings,
    enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
  })
  await expect(
    runtime!.settings.database.transaction(async (connection) => {
      const origin = await lockOrigin({ connection, effect })
      await coordinator.check({
        connection,
        origin,
        intents: [{ effectId: effect.id, requestId: "full" }],
      })
    }),
  ).rejects.toBeInstanceOf(MailboxFull)
  expect(await storedEffect(effect.id)).toMatchObject({ status: "processing", claimed_by: "owner" })
  expect(await messages("recover")).toHaveLength(0)
  expect(await messages("inspect")).toHaveLength(0)
})

it("surfaces an owner query failure without deciding abandonment", async () => {
  const effect = await processingEffect()
  await ageOwner(70_000)
  const coordinator = new EffectRecoveryCoordinator({
    settings: runtime!.settings,
    enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
  })
  await expect(
    runtime!.settings.database.transaction(async (connection) => {
      const origin = await lockOrigin({ connection, effect })
      const failingConnection: DatabaseConnection = {
        run: connection.run.bind(connection),
        all: connection.all.bind(connection),
        nowMilliseconds: connection.nowMilliseconds.bind(connection),
        get: <Row extends object>(sql: string, parameters?: readonly unknown[]) =>
          connection.get<Row>(
            sql.includes(runtime!.repository.table("processes"))
              ? `SELECT absent_recovery_column FROM ${runtime!.repository.table("processes")}`
              : sql,
            parameters,
          ),
      }
      await coordinator.check({
        connection: failingConnection,
        origin,
        intents: [{ effectId: effect.id, requestId: "lookup-error" }],
      })
    }),
  ).rejects.toThrow()
  expect(await storedEffect(effect.id)).toMatchObject({ status: "processing", claimed_by: "owner" })
  expect(await messages("recover")).toHaveLength(0)
  expect(await messages("inspect")).toHaveLength(0)
})

it.each([0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid recovery timeout %s before staging",
  (timeout) => {
    const actor = new ReportExport("invalid")
    actor.prepare(new Set(["recover", "inspect", "finished", "failed"]))
    expect(() => actor.startRecoverable({ timeoutMilliseconds: timeout })).toThrow(TypeError)
    expect(actor.hasIntents()).toBe(false)
  },
)

it("requires recovery opt-in for a timeout and both bindings for an explicit check", async () => {
  const actor = new ReportExport("invalid")
  expect(() => actor.emit("build_report", { recoveryTimeoutMilliseconds: 120_000 })).toThrow(
    "requires onRecovery",
  )
  runtime = await createTestRuntime()
  await runtime.ref(ReportExport, "export").start()
  const effect = await runtime.settings.database.connection((connection) =>
    connection.get<EffectRow>(`SELECT * FROM ${runtime!.repository.table("effects")}`),
  )
  const coordinator = new EffectRecoveryCoordinator({
    settings: runtime.settings,
    enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
  })
  await expect(
    runtime.settings.database.transaction(async (connection) => {
      const origin = await lockOrigin({ connection, effect: effect! })
      await coordinator.check({
        connection,
        origin,
        intents: [{ effectId: effect!.id, requestId: "unbound" }],
      })
    }),
  ).rejects.toThrow("onRecovery and onStatus")
  expect(await storedEffect(effect!.id)).toMatchObject({ status: "pending" })
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

it("does not opt a status-only effect into retirement", async () => {
  runtime = await createTestRuntime()
  await runtime.ref(ReportExport, "export").startStatusOnly()
  await runtime.repository.registerProcess("owner", "effect")
  const effect = await runtime.repository.claimEffect("owner")
  await ageOwner(70_000)
  await runtime.repository.registerProcess("new-owner", "effect")
  const reclaimed = await runtime.repository.claimEffect("new-owner")
  expect(reclaimed?.id).toBe(effect?.id)
  expect(reclaimed?.claimed_by).toBe("new-owner")
  expect(await messages("recover")).toHaveLength(0)
  expect(await messages("inspect")).toHaveLength(0)
})

it("applies the current runtime floor and handles a missing processing owner", async () => {
  const effect = await processingEffect({ timeoutMilliseconds: 1 })
  await ageOwner(70_000)
  runtime!.settings.processAliveThresholdMilliseconds = 120_000
  expect(await runtime!.repository.claimEffect("owner")).toBeUndefined()
  expect(await storedEffect(effect.id)).toMatchObject({ status: "processing", claimed_by: "owner" })
  await runtime!.settings.database.connection((connection) =>
    connection.run(
      `UPDATE ${runtime!.repository.table("effects")} SET claimed_by = NULL WHERE id = ?`,
      [effect.id],
    ),
  )
  expect(await runtime!.repository.claimEffect("owner")).toBeUndefined()
  expect(await messages("recover")).toHaveLength(1)
})

it("bounds each automatic pass and revisits remaining abandoned effects", async () => {
  await processingEffect()
  await runtime!.ref(ReportExport, "other").startRecoverable()
  expect(await runtime!.repository.claimEffect("owner")).toBeDefined()
  await ageOwner(70_000)
  runtime!.settings.claimScanLimit = 1
  expect(await runtime!.repository.claimEffect("owner")).toBeUndefined()
  expect(await messages("recover")).toHaveLength(1)
  expect(await runtime!.repository.claimEffect("owner")).toBeUndefined()
  expect(await messages("recover")).toHaveLength(2)
})

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "locks the origin before the effect when completion races retirement",
  async () => {
    const effect = await processingEffect()
    await ageOwner(70_000)
    const coordinator = new EffectRecoveryCoordinator({
      settings: runtime!.settings,
      enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
    })
    let completion: Promise<void | Error> = Promise.resolve()
    await runtime!.settings.database.transaction(async (connection) => {
      const origin = await lockOrigin({ connection, effect })
      const process = await connection.get<{ id: number }>("SELECT pg_backend_pid() AS id")
      completion = runtime!.repository.completeEffect(effect, "late").catch((error) => {
        if (!(error instanceof Error)) throw new TypeError("completion rejected without an Error")
        return error
      })
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

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "claiming pending work does not wait on a fresh recovery candidate",
  async () => {
    const effect = await processingEffect({ timeoutMilliseconds: 120_000 })
    await ageOwner(75_000)
    await runtime!.ref(ReportExport, "other").start()
    await runtime!.repository.registerProcess("other-owner", "effect")
    let claim: Promise<EffectRow | undefined> = Promise.resolve(undefined)
    try {
      await runtime!.settings.database.transaction(async (connection) => {
        await lockOrigin({ connection, effect })
        claim = runtime!.repository.claimEffect("other-owner")
        const selected = await withDeadline(claim)
        expect(selected?.actor_id).toBe("other")
      })
    } finally {
      await claim
    }
  },
)

async function withDeadline<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("independent work blocked on a fresh recovery candidate")),
          2_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
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

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "rechecks ownership when a pending claim wins before the recovery check",
  async () => {
    runtime = await createTestRuntime()
    await runtime.ref(ReportExport, "export").startRecoverable()
    const handle = await runtime.ref(ReportExport, "export").exportEffect
    const effect = await storedEffect(handle!.id)
    await runtime.repository.registerProcess("owner", "effect")
    const pausedDatabase = new PausingClaimDatabase({
      database: runtime.settings.database,
      table: "effects",
    })
    const claimant = new Repository({ ...runtime.settings, database: pausedDatabase })
    const claim = claimant.claimEffect("owner")
    const originLocked = deferred()
    const coordinator = new EffectRecoveryCoordinator({
      settings: runtime.settings,
      enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
    })
    try {
      await pausedDatabase.waitUntilClaimLocked()
      const recovery = runtime.settings.database.transaction(async (connection) => {
        const origin = await lockOrigin({ connection, effect: effect! })
        originLocked.resolve()
        await coordinator.check({
          connection,
          origin,
          intents: [{ effectId: effect!.id, requestId: "claim-wins" }],
        })
      })
      await originLocked.promise
      pausedDatabase.resume()
      await Promise.all([claim, recovery])
      expect((await messages("inspect"))[0]).toMatchObject({ outcome: "deferred" })
      expect(await messages("recover")).toHaveLength(0)
    } finally {
      pausedDatabase.resume()
      await claim
    }
  },
)

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "leaves a pending effect claimable after the recovery check wins",
  async () => {
    runtime = await createTestRuntime()
    await runtime.ref(ReportExport, "export").startRecoverable()
    const handle = await runtime.ref(ReportExport, "export").exportEffect
    const effect = await storedEffect(handle!.id)
    await runtime.repository.registerProcess("owner", "effect")
    const coordinator = new EffectRecoveryCoordinator({
      settings: runtime.settings,
      enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
    })
    await runtime.settings.database.transaction(async (connection) => {
      const origin = await lockOrigin({ connection, effect: effect! })
      await coordinator.check({
        connection,
        origin,
        intents: [{ effectId: effect!.id, requestId: "check-wins" }],
      })
      expect(await runtime!.repository.claimEffect("owner")).toBeUndefined()
    })
    expect((await runtime.repository.claimEffect("owner"))?.id).toBe(effect!.id)
    expect((await messages("inspect"))[0]).toMatchObject({ outcome: "pending" })
    expect(await messages("recover")).toHaveLength(0)
  },
)

it.skipIf(!process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:"))(
  "concurrent explicit checks and a replay share one retirement",
  async () => {
    const effect = await processingEffect()
    await ageOwner(70_000)
    const coordinator = new EffectRecoveryCoordinator({
      settings: runtime!.settings,
      enqueue: (connection, input) => runtime!.repository.enqueueInTransaction(connection, input),
    })
    const check = (requestId: string) =>
      runtime!.settings.database.transaction(async (connection) => {
        const origin = await lockOrigin({ connection, effect })
        await coordinator.check({
          connection,
          origin,
          intents: [{ effectId: effect.id, requestId }],
        })
      })
    let checks: Promise<void[]> = Promise.resolve([])
    try {
      await runtime!.settings.database.transaction(async (connection) => {
        await lockOrigin({ connection, effect })
        const process = await connection.get<{ id: number }>("SELECT pg_backend_pid() AS id")
        checks = Promise.all([check("one"), check("two")])
        await waitForBlockedTransaction({ connection, processId: process!.id, count: 2 })
      })
    } finally {
      await checks
    }
    await check("one")
    expect(await messages("recover")).toHaveLength(1)
    expect((await messages("inspect")).map((payload) => payload.outcome)).toEqual([
      "retired",
      "alreadyRetired",
    ])
  },
)

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

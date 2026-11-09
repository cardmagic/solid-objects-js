import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { NonRetryableError } from "../src/errors.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

const anHour = 3_600_000
const aliveThreshold = 1_000
const promptly = 700

class Exporter extends Actor {
  static override readonly actorType = "SingleOwnerExporter"
  static recoveredAt: number[] = []

  ping(): void {}

  emitExport(): void {
    this.emit("export")
  }

  recovered(): void {
    Exporter.recoveredAt.push(performance.now())
  }

  inspected(): void {}
}

let runtime: SolidObjectsRuntime | undefined
let stopRuntime: (() => Promise<void>) | undefined
let exportRuns = 0

afterEach(async () => {
  await stopRuntime?.()
  stopRuntime = undefined
  await runtime?.close()
  runtime = undefined
  exportRuns = 0
  Exporter.recoveredAt = []
})

async function installedRuntime(options: { singleOwner: boolean }): Promise<SolidObjectsRuntime> {
  runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    singleOwner: options.singleOwner,
    pollingIntervalMilliseconds: anHour,
    idlePollingIntervalMilliseconds: anHour,
    processAliveThresholdMilliseconds: aliveThreshold,
    authorizeMessage: () => true,
    authorizeAdministration: () => true,
  })
  runtime.register(Exporter)
  runtime.registerEffect("export", () => {
    exportRuns += 1
    if (exportRuns === 1) throw new NonRetryableError("the export service was down")
  })
  await runtime.install()
  return runtime
}

function start(target: SolidObjectsRuntime): void {
  const controller = new AbortController()
  const running = target.run(controller.signal)
  stopRuntime = async () => {
    controller.abort()
    await running
  }
}

async function eventually<Value>(options: {
  read: () => Value | Promise<Value>
  until: (value: Value) => boolean
  timeoutMilliseconds: number
}): Promise<Value> {
  const deadline = performance.now() + options.timeoutMilliseconds
  let value = await options.read()
  while (!options.until(value) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    value = await options.read()
  }
  return value
}

describe("singleOwner recovery work", () => {
  it.each([
    { singleOwner: true, runs: 2 },
    { singleOwner: false, runs: 1 },
  ])("runs a redriven effect promptly only when singleOwner is $singleOwner", async (options) => {
    const target = await installedRuntime({ singleOwner: options.singleOwner })
    start(target)
    await target.ref(Exporter, "redrive").send.emitExport()
    expect(
      await eventually({
        read: async () => (await target.deadLetters.effects.all()).length,
        until: (count) => count === 1,
        timeoutMilliseconds: promptly,
      }),
    ).toBe(1)

    await target.deadLetters.effects.redrive()

    expect(
      await eventually({
        read: () => exportRuns,
        until: (runs) => runs === 2,
        timeoutMilliseconds: promptly,
      }),
    ).toBe(options.runs)
  })

  it("retires the effect of a crashed owner when its recovery timeout ends", async () => {
    const target = await installedRuntime({ singleOwner: true })
    const message = await target.repository.enqueue({
      actorType: Exporter.actorType,
      actorId: "recovery",
      operation: "ping",
      deliveryMode: "async",
      arguments: {},
    })
    const recoveryTimeout = aliveThreshold + 600
    await target.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const heartbeat = now - aliveThreshold - 100
      await connection.run(
        `INSERT INTO solid_objects_processes
         (id, kind, hostname, host_process_id, metadata, started_at_ms, heartbeat_at_ms, shutdown_state)
         VALUES ('crashed', 'effect_worker', 'other-host', 1, '{}', ?, ?, 'running')`,
        [heartbeat, heartbeat],
      )
      await connection.run(
        `INSERT INTO solid_objects_effects
         (id, message_id, instance_id, name, arguments, status, max_attempts, available_at_ms, claimed_by)
         VALUES ('stuck', ?, ?, 'export', '{}', 'processing', 3, ?, 'crashed')`,
        [message.id, message.instance_id, heartbeat],
      )
      await connection.run(
        `INSERT INTO solid_objects_effect_recoveries
         (effect_id, instance_id, recovery_operation, status_operation, recovery_timeout_ms)
         VALUES ('stuck', ?, 'recovered', 'inspected', ?)`,
        [message.instance_id, recoveryTimeout],
      )
    })
    const startedAt = performance.now()

    start(target)

    const recovered = await eventually({
      read: () => Exporter.recoveredAt,
      until: (times) => times.length === 1,
      timeoutMilliseconds: 500 + promptly,
    })
    expect(recovered).toHaveLength(1)
    expect(recovered[0]! - startedAt).toBeGreaterThanOrEqual(400)
  })
})

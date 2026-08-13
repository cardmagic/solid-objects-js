import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import type { InstrumentationEvent, SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

class HousekeepingActor extends Actor {
  static override readonly actorType = "HousekeepingActor"

  run(): void {}
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("scheduled housekeeping", () => {
  it("does not schedule disabled housekeeping", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const prune = vi.spyOn(runtime.repository, "pruneRetention")
    const cleanup = vi.spyOn(runtime.repository, "cleanupStaleProcesses")
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()
    await running

    expect(prune).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it("prunes expired message and process history automatically", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      retentionIntervalMilliseconds: 5,
      messageRetentionMilliseconds: 1,
      processRetentionMilliseconds: 1,
      instrumentation: (event) => events.push(event),
    })
    runtime.register(HousekeepingActor)
    await runtime.install()
    const message = await HousekeepingActor.ref("expired").send.run()
    await runtime.worker().runUntilIdle()
    await runtime.repository.registerProcess("expired-process", "worker")
    await runtime.repository.stopProcess("expired-process")
    await runtime.settings.database.connection(async (connection) => {
      await connection.run(
        `UPDATE ${runtime?.repository.table("messages")} SET completed_at_ms = 0 WHERE id = ?`,
        [message.id],
      )
      await connection.run(
        `UPDATE ${runtime?.repository.table("processes")} SET stopped_at_ms = 0 WHERE id = ?`,
        ["expired-process"],
      )
    })
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await eventually(async () => {
      const retainedMessage = await runtime?.repository.findMessage(message.id)
      const retainedProcess = await runtime?.settings.database.connection((connection) =>
        connection.get(`SELECT id FROM ${runtime?.repository.table("processes")} WHERE id = ?`, [
          "expired-process",
        ]),
      )
      return retainedMessage === undefined && retainedProcess === undefined
    })
    controller.abort()
    await running

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "solid_objects.messages.pruned",
          attributes: expect.objectContaining({ count: expect.any(Number) }),
        }),
        expect.objectContaining({
          name: "solid_objects.processes.pruned",
          attributes: expect.objectContaining({ count: expect.any(Number) }),
        }),
      ]),
    )
  })

  it("recovers stale process ownership automatically", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 5,
      processAliveThresholdMilliseconds: 1,
      instrumentation: (event) => events.push(event),
    })
    await runtime.install()
    await runtime.repository.registerProcess("stale", "worker")
    await runtime.settings.database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("processes")} SET heartbeat_at_ms = 0 WHERE id = ?`,
        ["stale"],
      ),
    )
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await eventually(async () => {
      const process = await runtime?.settings.database.connection((connection) =>
        connection.get<{ shutdown_state: string }>(
          `SELECT shutdown_state FROM ${runtime?.repository.table("processes")} WHERE id = ?`,
          ["stale"],
        ),
      )
      return process?.shutdown_state === "stopped"
    })
    controller.abort()
    await running

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "solid_objects.processes.cleaned",
          attributes: { count: 1 },
        }),
      ]),
    )
  })

  it("retries failed retention without waiting for the normal interval", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      retentionIntervalMilliseconds: 60_000,
      deadProcessCleanupIntervalMilliseconds: 0,
      supervisorRestartDelayMilliseconds: 1,
      supervisorMaximumRestartDelayMilliseconds: 5,
      instrumentation: (event) => events.push(event),
    })
    await runtime.install()
    const originalPrune = runtime.repository.pruneRetention.bind(runtime.repository)
    const prune = vi
      .spyOn(runtime.repository, "pruneRetention")
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementation(originalPrune)
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await eventually(() => prune.mock.calls.length >= 3)
    controller.abort()
    await running

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "solid_objects.supervisor.retention_failed",
          attributes: { errorName: "Error", failureCount: 1 },
        }),
      ]),
    )
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configureSolidObjects({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    workerCount: 1,
    effectWorkerCount: 0,
    reminderSchedulerCount: 0,
    broadcastWorkerCount: 0,
    retentionIntervalMilliseconds: 0,
    deadProcessCleanupIntervalMilliseconds: 0,
    ...overrides,
  })
}

async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await condition()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("condition was not met")
}

import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"

class LifecycleCounter extends Actor {
  static override readonly actorType = "LifecycleCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }

  async incrementSlowly(): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 60))
    this.count += 1
    return this.count
  }
}

class FairActor extends Actor {
  static override readonly actorType = "FairActor"
  static runs: string[] = []

  record(): void {
    FairActor.runs.push(this.actorId)
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  FairActor.runs = []
})

describe("runtime lifecycle", () => {
  it("runs configured workers until the abort signal and stops their processes", async () => {
    runtime = configuredRuntime({
      workerCount: 2,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      broadcastWorkerCount: 0,
    })
    await runtime.install()
    const message = await LifecycleCounter.ref("supervised").send.increment()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await eventually(async () => (await message.status()) === "completed")
    controller.abort()
    await running

    expect(await message.result()).toBe(1)
    const processes = await runtime.settings.database.connection((connection) =>
      connection.all<{
        shutdown_state: string
      }>(`SELECT shutdown_state FROM ${runtime?.repository.table("processes")}`),
    )
    expect(processes).toHaveLength(2)
    expect(processes.every((process) => process.shutdown_state === "stopped")).toBe(true)
  })

  it("does not start workers for an already-aborted signal", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const controller = new AbortController()
    controller.abort()

    await runtime.run(controller.signal)

    const processes = await runtime.settings.database.connection((connection) =>
      connection.all(`SELECT id FROM ${runtime?.repository.table("processes")}`),
    )
    expect(processes).toEqual([])
  })

  it("refuses to close while supervised workers are running", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await expect(runtime.close()).rejects.toThrow("abort runtime.run()")
    controller.abort()
    await running
  })

  it("cleans up constructed components and resets after a factory fails", async () => {
    runtime = configuredRuntime()
    const requestShutdown = vi.fn()
    const stop = vi.fn()
    runtime.registerComponent(() => ({
      run: async () => {},
      requestShutdown,
      stopped: () => false,
      stop,
    }))
    runtime.registerComponent(() => {
      throw new Error("component construction failed")
    })

    await expect(runtime.run(new AbortController().signal)).rejects.toThrow(
      "component construction failed",
    )
    expect(requestShutdown).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    await expect(runtime.run(new AbortController().signal)).rejects.toThrow(
      "component construction failed",
    )
  })

  it("rebuilds a component through its factory after an unexpected exit", async () => {
    const events: string[] = []
    let builds = 0
    let runs = 0
    runtime = configuredRuntime({
      supervisorRestartDelayMilliseconds: 1,
      instrumentation: ({ name }) => events.push(name),
    })
    runtime.registerComponent(() => {
      builds += 1
      let stopping = false
      return {
        run: async (signal) => {
          runs += 1
          if (runs === 1) throw new Error("component crashed")
          await aborted(signal)
          stopping = true
        },
        requestShutdown: () => {
          stopping = true
        },
        stopped: () => stopping,
        stop: () => {
          stopping = true
        },
      }
    })
    await runtime.install()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await eventually(() => builds >= 2 && runs >= 2)
    controller.abort()
    await running

    expect(events).toContain("solid_objects.supervisor.role_replaced")
  })

  it("paces a component factory that keeps failing", async () => {
    let builds = 0
    const buildTimes: number[] = []
    let fourthBuild: (() => void) | undefined
    const builtFourTimes = new Promise<void>((resolve) => {
      fourthBuild = resolve
    })
    runtime = configuredRuntime({
      supervisorRestartDelayMilliseconds: 10,
      supervisorMaximumRestartDelayMilliseconds: 20,
    })
    runtime.registerComponent(() => {
      builds += 1
      buildTimes.push(performance.now())
      if (builds === 4) fourthBuild?.()
      if (builds > 1) throw new Error("factory unavailable")
      return {
        run: async () => {
          throw new Error("component unavailable")
        },
        requestShutdown: () => {},
        stopped: () => true,
        stop: () => {},
      }
    })
    await runtime.install()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    await builtFourTimes
    controller.abort()
    await running

    expect(builds).toBe(4)
    expect((buildTimes[3] ?? 0) - (buildTimes[0] ?? 0)).toBeGreaterThanOrEqual(40)
  })

  it("does not replace a failed component after shutdown", async () => {
    let builds = 0
    let fail: (() => void) | undefined
    runtime = configuredRuntime({ supervisorRestartDelayMilliseconds: 1 })
    runtime.registerComponent(() => {
      builds += 1
      return {
        run: () =>
          new Promise<void>((_resolve, reject) => {
            fail = () => reject(new Error("late failure"))
          }),
        requestShutdown: () => fail?.(),
        stopped: () => false,
        stop: () => {},
      }
    })
    await runtime.install()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)
    await eventually(() => fail !== undefined)

    controller.abort()
    await running
    const buildsAtShutdown = builds

    expect(builds).toBe(buildsAtShutdown)
  })

  it("renews the activation lease while a long message is running", async () => {
    runtime = configuredRuntime({
      leaseDurationMilliseconds: 30,
      leaseRenewalIntervalMilliseconds: 5,
    })
    await runtime.install()

    expect(await LifecycleCounter.ref("slow").incrementSlowly()).toBe(1)
  })

  it("recovers an expired claimed message", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const reference = LifecycleCounter.ref("recovered")
    const message = await reference.send.increment()
    await runtime.repository.registerProcess("abandoned", "worker")
    const abandonedTurn = await runtime.repository.claim("abandoned")
    expect(abandonedTurn?.message.id).toBe(message.id)
    await runtime.settings.database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("instances")}
       SET activation_expires_at_ms = 0 WHERE id = ?`,
        [abandonedTurn?.instance.id],
      ),
    )

    expect(await runtime.worker().runUntilIdle()).toBe(1)

    expect(await message.result()).toBe(1)
    const stored = await runtime.repository.findMessage(message.id)
    expect(Number(stored?.attempt_count)).toBe(2)
  })

  it("drains a bounded activation pass before yielding", async () => {
    runtime = configuredRuntime({ maxMessagesPerActivationPass: 2 })
    runtime.register(FairActor)
    await runtime.install()
    const actor = FairActor.ref("hot")
    await actor.send.record()
    await actor.send.record()
    await actor.send.record()

    expect(await runtime.worker().runOnce()).toBe(2)
    expect(FairActor.runs).toEqual(["hot", "hot"])
    expect(await runtime.worker().runUntilIdle()).toBe(1)
  })

  it("yields a hot actor so an older waiting actor runs next", async () => {
    runtime = configuredRuntime({ maxMessagesPerActivationPass: 1 })
    runtime.register(FairActor)
    await runtime.install()
    await FairActor.ref("hot").send.record()
    await FairActor.ref("hot").send.record()
    await FairActor.ref("waiting").send.record()
    await runtime.settings.database.connection(async (connection) => {
      await connection.run(
        `UPDATE ${runtime?.repository.table("ready_messages")}
         SET available_at_ms = CASE
           WHEN instance_id = (SELECT id FROM ${runtime?.repository.table("instances")} WHERE actor_id = 'hot') THEN 0
           ELSE 1
         END`,
      )
    })
    const worker = runtime.worker()

    expect(await worker.runOnce()).toBe(1)
    expect(await worker.runOnce()).toBe(1)

    expect(FairActor.runs).toEqual(["hot", "waiting"])
  })

  it("closes idempotently", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await runtime.close()
    await runtime.close()
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
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 3,
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

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

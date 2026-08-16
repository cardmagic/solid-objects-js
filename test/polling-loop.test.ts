import { afterEach, describe, expect, it, vi } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import type { InstrumentationEvent } from "../src/configuration.js"
import type { WakeUpAdapter, WakeUpRole, WakeUpWatch } from "../src/wake-up.js"

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("idle polling", () => {
  it("backs an idle worker off to the configured ceiling and reports each transition", async () => {
    const controller = new AbortController()
    const intervals: number[] = []
    const events: InstrumentationEvent[] = []
    const wakeUp = new ImmediateTimeoutWakeUpAdapter((interval) => {
      intervals.push(interval)
      if (intervals.length === 7) controller.abort()
    })
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      pollingIntervalMilliseconds: 25,
      idlePollingIntervalMilliseconds: 1_000,
      workerCount: 1,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      instrumentation: (event) => events.push(event),
      wakeUp,
    })
    await runtime.install()
    const worker = runtime.worker()

    await worker.run(controller.signal)

    expect(intervals).toEqual([25, 50, 100, 200, 400, 800, 1_000])
    expect(worker.currentPollingIntervalMilliseconds).toBe(1_000)
    expect(
      events
        .filter(({ name }) => name === "solid_objects.polling.interval_changed")
        .map(({ attributes }) => attributes),
    ).toEqual([
      {
        role: "actors",
        reason: "idle",
        previousIntervalMilliseconds: 25,
        currentIntervalMilliseconds: 50,
      },
      {
        role: "actors",
        reason: "idle",
        previousIntervalMilliseconds: 50,
        currentIntervalMilliseconds: 100,
      },
      {
        role: "actors",
        reason: "idle",
        previousIntervalMilliseconds: 100,
        currentIntervalMilliseconds: 200,
      },
      {
        role: "actors",
        reason: "idle",
        previousIntervalMilliseconds: 200,
        currentIntervalMilliseconds: 400,
      },
      {
        role: "actors",
        reason: "idle",
        previousIntervalMilliseconds: 400,
        currentIntervalMilliseconds: 800,
      },
      {
        role: "actors",
        reason: "idle",
        previousIntervalMilliseconds: 800,
        currentIntervalMilliseconds: 1_000,
      },
    ])
  })

  it("backs an idle effect worker off to the configured ceiling", async () => {
    const controller = new AbortController()
    const intervals: number[] = []
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      pollingIntervalMilliseconds: 25,
      idlePollingIntervalMilliseconds: 1_000,
      workerCount: 0,
      effectWorkerCount: 1,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      wakeUp: new ImmediateTimeoutWakeUpAdapter((interval) => {
        intervals.push(interval)
        if (intervals.length === 7) controller.abort()
      }),
    })
    await runtime.install()
    const worker = runtime.effectWorker()

    await worker.run(controller.signal)

    expect(intervals).toEqual([25, 50, 100, 200, 400, 800, 1_000])
    expect(worker.currentPollingIntervalMilliseconds).toBe(1_000)
  })

  it("backs idle reminder and broadcast roles off to the configured ceiling", async () => {
    for (const role of ["reminders", "broadcasts"] as const) {
      const controller = new AbortController()
      const intervals: number[] = []
      runtime = createRuntime({
        database: sqlite({ path: ":memory:" }),
        pollingIntervalMilliseconds: 25,
        idlePollingIntervalMilliseconds: 1_000,
        workerCount: 0,
        effectWorkerCount: 0,
        reminderSchedulerCount: role === "reminders" ? 1 : 0,
        broadcastWorkerCount: role === "broadcasts" ? 1 : 0,
        retentionIntervalMilliseconds: 0,
        deadProcessCleanupIntervalMilliseconds: 0,
        ...(role === "broadcasts" ? { authorizeSubscription: () => true } : {}),
        wakeUp: new ImmediateTimeoutWakeUpAdapter((interval) => {
          intervals.push(interval)
          if (intervals.length === 7) controller.abort()
        }),
      })
      await runtime.install()
      const component =
        role === "reminders" ? runtime.reminderScheduler() : runtime.broadcastWorker()

      await component.run(controller.signal)

      expect(intervals, role).toEqual([25, 50, 100, 200, 400, 800, 1_000])
      expect(component.currentPollingIntervalMilliseconds, role).toBe(1_000)
      await runtime.close()
      runtime = undefined
    }
  })

  it("never backs an actor worker off beyond its lease renewal interval", async () => {
    const controller = new AbortController()
    const intervals: number[] = []
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      pollingIntervalMilliseconds: 25,
      idlePollingIntervalMilliseconds: 1_000,
      leaseDurationMilliseconds: 300,
      leaseRenewalIntervalMilliseconds: 100,
      workerCount: 1,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      wakeUp: new ImmediateTimeoutWakeUpAdapter((interval) => {
        intervals.push(interval)
        if (intervals.length === 5) controller.abort()
      }),
    })
    await runtime.install()

    await runtime.worker().run(controller.signal)

    expect(intervals).toEqual([25, 50, 100, 100, 100])
  })

  it("resets an actor worker to its fast interval after processed work", async () => {
    const controller = new AbortController()
    const intervals: number[] = []
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      pollingIntervalMilliseconds: 25,
      idlePollingIntervalMilliseconds: 1_000,
      workerCount: 1,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      wakeUp: new ImmediateTimeoutWakeUpAdapter((interval) => {
        intervals.push(interval)
        if (intervals.length === 3) controller.abort()
      }),
    })
    await runtime.install()
    const worker = runtime.worker()
    vi.spyOn(worker, "runOnce")
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0)

    await worker.run(controller.signal)

    expect(intervals).toEqual([25, 50, 25])
  })

  it("resets an actor worker to its fast interval after a wake-up", async () => {
    const controller = new AbortController()
    const intervals: number[] = []
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      pollingIntervalMilliseconds: 25,
      idlePollingIntervalMilliseconds: 1_000,
      workerCount: 1,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      wakeUp: new SequencedWakeUpAdapter({
        results: [false, false, true, false],
        waiting: (interval) => {
          intervals.push(interval)
          if (intervals.length === 4) controller.abort()
        },
      }),
    })
    await runtime.install()
    const worker = runtime.worker()
    vi.spyOn(worker, "runOnce").mockResolvedValue(0)

    await worker.run(controller.signal)

    expect(intervals).toEqual([25, 50, 100, 25])
  })

  it("keeps a legacy wake-up adapter at the fast interval", async () => {
    const controller = new AbortController()
    const intervals: number[] = []
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      pollingIntervalMilliseconds: 25,
      idlePollingIntervalMilliseconds: 1_000,
      workerCount: 1,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      wakeUp: new LegacyWakeUpAdapter((interval) => {
        intervals.push(interval)
        if (intervals.length === 3) controller.abort()
      }),
    })
    await runtime.install()
    const worker = runtime.worker()
    vi.spyOn(worker, "runOnce").mockResolvedValue(0)

    await worker.run(controller.signal)

    expect(intervals).toEqual([25, 25, 25])
  })

  it("warns once when another process shares the database without a wake-up adapter", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      pollingIntervalMilliseconds: 25,
      workerCount: 2,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      logger,
    })
    await runtime.install()
    await runtime.repository.registerProcess("other-process", "worker")
    await runtime.settings.database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("processes")} SET host_process_id = ? WHERE id = ?`,
        [process.pid + 1, "other-process"],
      ),
    )
    const controller = new AbortController()
    const running = runtime.run(controller.signal)

    try {
      await vi.waitFor(
        () => {
          expect(logger.warn).toHaveBeenCalledTimes(1)
        },
        { timeout: 500, interval: 10 },
      )
    } finally {
      controller.abort()
      await running
    }

    expect(logger.warn).toHaveBeenCalledWith({
      event: "solid_objects.polling_only_cross_process_wake_up",
      pollingIntervalMilliseconds: 25,
      idlePollingIntervalMilliseconds: 1_000,
    })
  })

  it("does not warn when a cross-process wake-up adapter is configured", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      workerCount: 1,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
      retentionIntervalMilliseconds: 0,
      deadProcessCleanupIntervalMilliseconds: 0,
      logger,
      wakeUp: new ImmediateTimeoutWakeUpAdapter(() => {}),
    })
    await runtime.install()
    await runtime.repository.registerProcess("other-process", "worker")
    await runtime.settings.database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("processes")} SET host_process_id = ? WHERE id = ?`,
        [process.pid + 1, "other-process"],
      ),
    )

    await runtime.warnIfPollingIsOnlyCrossProcessWakeUp()

    expect(logger.warn).not.toHaveBeenCalled()
  })
})

class ImmediateTimeoutWakeUpAdapter implements WakeUpAdapter {
  constructor(private readonly waiting: (timeoutMilliseconds: number) => void) {}

  watch(_role: WakeUpRole): WakeUpWatch {
    return {
      wait: async ({ timeoutMilliseconds }) => {
        this.waiting(timeoutMilliseconds)
        return false
      },
    }
  }

  notify(_role: WakeUpRole): void {}

  close(): void {}
}

class SequencedWakeUpAdapter implements WakeUpAdapter {
  private index = 0

  constructor(
    private readonly options: {
      results: readonly boolean[]
      waiting: (timeoutMilliseconds: number) => void
    },
  ) {}

  watch(_role: WakeUpRole): WakeUpWatch {
    return {
      wait: async ({ timeoutMilliseconds }) => {
        this.options.waiting(timeoutMilliseconds)
        const result = this.options.results[this.index]
        this.index += 1
        return result ?? false
      },
    }
  }

  notify(_role: WakeUpRole): void {}

  close(): void {}
}

class LegacyWakeUpAdapter implements WakeUpAdapter {
  constructor(private readonly waiting: (timeoutMilliseconds: number) => void) {}

  watch(_role: WakeUpRole): WakeUpWatch {
    return {
      wait: async ({ timeoutMilliseconds }) => {
        this.waiting(timeoutMilliseconds)
      },
    }
  }

  notify(_role: WakeUpRole): void {}

  close(): void {}
}

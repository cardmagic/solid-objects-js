import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import {
  InProcessWakeUpAdapter,
  type WakeUpAdapter,
  type WakeUpRole,
  type WakeUpWatch,
} from "../src/wake-up.js"

class WakeTarget extends Actor {
  static override readonly actorType = "WakeTarget"

  received = 0

  receive(): void {
    this.received += 1
  }
}

class WakeSource extends Actor {
  static override readonly actorType = "WakeSource"

  count = 0

  createWork(): void {
    this.count += 1
    this.emit("wakeEffect")
    this.schedule({ at: new Date(Date.now() + 60_000) }).createWork!()
    this.sendTo(WakeTarget.ref("target")).receive()
  }

  override observables(): Record<string, unknown> {
    return { count: this.count }
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("in-process wake-up", () => {
  it("does not miss a signal sent before waiting", async () => {
    const wakeUp = new InProcessWakeUpAdapter()
    const watch = wakeUp.watch("actors")

    wakeUp.notify("actors")

    await expect(
      Promise.race([
        watch.wait({ timeoutMilliseconds: 10_000 }),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("wake-up was missed")), 100),
        ),
      ]),
    ).resolves.toBeUndefined()
  })

  it("wakes every waiter for a role without waking other roles", async () => {
    const wakeUp = new InProcessWakeUpAdapter()
    const actors = [wakeUp.watch("actors"), wakeUp.watch("actors")]
    const effects = wakeUp.watch("effects")
    const actorWaits = actors.map((watch) => watch.wait({ timeoutMilliseconds: 10_000 }))
    let effectResolved = false
    void effects.wait({ timeoutMilliseconds: 10_000 }).then(() => {
      effectResolved = true
    })

    wakeUp.notify("actors")
    await Promise.all(actorWaits)

    expect(effectResolved).toBe(false)
    wakeUp.close()
  })

  it("signals every role created by a committed actor turn", async () => {
    const wakeUp = new RecordingWakeUpAdapter()
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      wakeUp,
    })
    runtime.registerEffect("wakeEffect", () => undefined)
    runtime.register(WakeSource)
    runtime.register(WakeTarget)
    await runtime.install()

    await WakeSource.ref("source").createWork()

    expect(new Set(wakeUp.notifications)).toEqual(
      new Set<WakeUpRole>(["actors", "effects", "reminders", "broadcasts"]),
    )
  })

  it("interrupts a long polling wait when a message commits", async () => {
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      pollingIntervalMilliseconds: 10_000,
      workerCount: 1,
      effectWorkerCount: 0,
      reminderSchedulerCount: 0,
    })
    runtime.register(WakeTarget)
    await runtime.install()
    const controller = new AbortController()
    const running = runtime.run(controller.signal)
    await processRegistered("worker")

    const message = await WakeTarget.ref("live").send.receive()
    await eventually(async () => (await message.status()) === "completed")

    controller.abort()
    await running
    expect(await message.result()).toBeNull()
  })

  it("isolates notification failures from durable work", async () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: vi.fn(),
    }
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      logger,
      wakeUp: {
        watch: () => ({ wait: async () => {} }),
        notify: () => {
          throw new Error("private adapter failure")
        },
        close: () => {},
      },
    })
    runtime.register(WakeTarget)
    await runtime.install()

    await expect(WakeTarget.ref("safe").receive()).resolves.toBeNull()

    expect(logger.error).toHaveBeenCalledWith({
      event: "solid_objects.wake_up.failed",
      role: "actors",
      errorName: "Error",
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private adapter failure")
  })
})

class RecordingWakeUpAdapter implements WakeUpAdapter {
  readonly notifications: WakeUpRole[] = []

  watch(_role: WakeUpRole): WakeUpWatch {
    return { wait: async () => {} }
  }

  notify(role: WakeUpRole): void {
    this.notifications.push(role)
  }

  close(): void {}
}

async function processRegistered(kind: string): Promise<void> {
  await eventually(async () => {
    const row = await runtime?.settings.database.connection((connection) =>
      connection.get<{ count: number | bigint }>(
        `SELECT COUNT(*) AS count FROM ${runtime?.repository.table("processes")} WHERE kind = ?`,
        [kind],
      ),
    )
    return Number(row?.count ?? 0) > 0
  })
}

async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await condition()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("condition was not met")
}

import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import type { InstrumentationEvent, SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

class ReminderActor extends Actor {
  static override readonly actorType = "ReminderAdministrationActor"

  count = 0

  arm({ at }: { at: string }): void {
    this.schedule({ at: new Date(at) }).increment!()
  }

  increment(): void {
    this.count += 1
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("reminder administration", () => {
  it("denies inspection and resume before revealing reminder existence", async () => {
    runtime = configureSolidObjects({ database: sqlite({ path: ":memory:" }) })
    await runtime.install()

    await expect(runtime.reminders.all()).rejects.toBeInstanceOf(Unauthorized)
    await expect(runtime.reminders.resume("missing")).rejects.toBeInstanceOf(Unauthorized)
  })

  it("inspects immutable reminder metadata and resumes a paused alarm idempotently", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await ReminderActor.ref("one").arm({ at: new Date(Date.now() - 1_000).toISOString() })
    await runtime.settings.database.connection((connection) =>
      connection.run(`UPDATE ${runtime?.repository.table("reminders")} SET operation = ?`, [
        "removedOperation",
      ]),
    )
    expect(await runtime.reminderScheduler().runOnce()).toBe(1)

    const paused = await runtime.reminders.all({
      actorType: ReminderActor.actorType,
      status: "paused",
      authorizationContext: "operator",
    })

    expect(paused.items).toHaveLength(1)
    expect(paused.items[0]).toMatchObject({
      actorType: ReminderActor.actorType,
      actorId: "one",
      operation: "removedOperation",
      status: "paused",
      errorName: "UnknownOperation",
    })
    expect(Object.isFrozen(paused)).toBe(true)
    expect(Object.isFrozen(paused.items)).toBe(true)
    expect(Object.isFrozen(paused.items[0])).toBe(true)
    const runAt = new Date(Date.now() + 60_000)
    const first = await runtime.reminders.resume(paused.items[0]!.id, {
      runAt,
      authorizationContext: "operator",
    })
    const second = await runtime.reminders.resume(paused.items[0]!.id, {
      runAt,
      authorizationContext: "operator",
    })
    expect(first).toEqual(second)
    expect(first).toMatchObject({ status: "scheduled", runAt })
  })

  it("reports only reminder schedules that move an existing alarm", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({ instrumentation: (event) => events.push(event) })
    await runtime.install()
    const reference = ReminderActor.ref("replacement")
    const first = new Date(Date.now() + 60_000).toISOString()
    const second = new Date(Date.now() + 120_000).toISOString()

    await reference.arm({ at: first })
    await reference.arm({ at: second })

    const replacements = events.filter(({ name }) => name === "solid_objects.reminder.replaced")
    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.attributes).toMatchObject({
      actorType: ReminderActor.actorType,
      actorId: "replacement",
      operation: "increment",
      previousRunAt: new Date(first).toISOString(),
      nextRunAt: new Date(second).toISOString(),
    })
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
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    ...overrides,
  })
}

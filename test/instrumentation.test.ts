import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import type { InstrumentationEvent, SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

class InstrumentedActor extends Actor {
  static override readonly actorType = "InstrumentedActor"

  secret = "initial"

  update({ secret }: { secret: string }): string {
    this.secret = secret
    return `result:${secret}`
  }

  rejectUpdate(): void {
    this.reject("not_allowed", { message: "private rejection", details: { secret: this.secret } })
  }

  fail(): void {
    throw new Error(`private failure ${this.secret}`)
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("structured instrumentation", () => {
  it("emits immutable lifecycle events without arguments, state, results, or error messages", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({ instrumentation: (event) => events.push(event) })
    await runtime.install()
    const reference = InstrumentedActor.ref("one")
    const message = await reference.send.update({ secret: "do-not-observe" })

    await runtime.worker().runUntilIdle()
    await reference.send.rejectUpdate()
    await reference.send.fail()
    await runtime.worker().runUntilIdle()
    await reference.destroy()

    expect(events.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "solid_objects.message.enqueued",
        "solid_objects.message.started",
        "solid_objects.message.completed",
        "solid_objects.message.rejected",
        "solid_objects.message.failed",
        "solid_objects.actor.destroyed",
      ]),
    )
    const enqueued = events.find(
      (event) =>
        event.name === "solid_objects.message.enqueued" &&
        event.attributes.messageId === message.id,
    )
    expect(enqueued?.attributes).toMatchObject({
      messageId: message.id,
      actorType: InstrumentedActor.actorType,
      actorId: "one",
      operation: "update",
      deliveryMode: "async",
    })
    expect(Object.isFrozen(enqueued)).toBe(true)
    expect(Object.isFrozen(enqueued?.attributes)).toBe(true)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("do-not-observe")
    expect(serialized).not.toContain("private rejection")
    expect(serialized).not.toContain("private failure")
    expect(serialized).not.toContain("result:")
  })

  it("isolates instrumentation failures from durable work", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    runtime = configuredRuntime({
      instrumentation: () => {
        throw new Error("sink unavailable")
      },
      logger,
    })
    await runtime.install()

    expect(await InstrumentedActor.ref("safe").update({ secret: "committed" })).toBe(
      "result:committed",
    )
    expect(logger.error).toHaveBeenCalledWith({
      event: "solid_objects.instrumentation.failed",
      instrumentationEvent: expect.any(String),
      errorName: "Error",
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
    maxAttempts: 1,
    ...overrides,
  })
}

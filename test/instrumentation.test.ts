import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import type { InstrumentationEvent, SolidObjectsConfiguration } from "../src/configuration.js"
import { postgresql } from "../src/database/postgresql.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { expectPortableEvents } from "./support/portable-telemetry.js"

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

  arrange(): void {
    this.emit("telemetry-effect", { arguments: { secret: this.secret } })
    this.schedule({ at: new Date(0) }).update({ secret: "reminder-private" })
  }

  fail(): void {
    throw new Error(`private failure ${this.secret}`)
  }

  commit(): void {
    this.commitAction("telemetry-action")
  }

  commitBadly(): void {
    this.commitAction("telemetry-failure")
  }
}

class ActivationFailure extends Actor {
  static override readonly actorType = "ActivationFailure"

  protected override async onActivate(): Promise<void> {
    throw new Error("private activation failure")
  }

  run(): void {}
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.repository.resetForTesting()
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

  it("emits portable SQL lifecycle events that match the shared attribute contract", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      maxAttempts: 2,
      retryDelayMilliseconds: () => 0,
      instrumentation: (event) => {
        events.push(event)
      },
    })
    await runtime.install()
    runtime.registerEffect("telemetry-effect", () => "delivered")
    runtime.registerCommitAction("telemetry-action", () => {})
    runtime.registerCommitAction("telemetry-failure", () => {
      throw new Error("private commit failure")
    })
    const reference = InstrumentedActor.ref("contract")
    await reference.update({ secret: "committed" })
    await reference.send.rejectUpdate()
    await reference.send.fail()
    await reference.send.commit()
    await reference.send.commitBadly()
    await reference.send.arrange()
    await runtime.enqueueInternalMessage({
      actorType: reference.actorType,
      actorId: reference.actorId,
      operation: "update",
      argumentsValue: { secret: "recovered" },
      idempotencyKey: "effect:contract:recovery",
    })
    await reference.diagnostics({ limit: 1 })
    await runtime.worker().runUntilIdle()
    await ActivationFailure.ref("contract").send.run()
    await runtime
      .worker()
      .runUntilIdle()
      .catch(() => {})
    await runtime.effectWorker().runUntilIdle()
    await runtime.reminderScheduler().runOnce()
    await reference.snapshot()

    expectPortableEvents(events, [
      "activation.started",
      "activation.completed",
      "activation.failed",
      "message.enqueued",
      "message.started",
      "message.completed",
      "message.rejected",
      "message.failed",
      "message.retry",
      "dead_letter.created",
      "commit_action.started",
      "commit_action.completed",
      "commit_action.failed",
      "recovery.completed",
      "mailbox.depth",
      "outbox.age",
      "reminder.enqueued",
      "snapshot.read",
    ])
    expect(
      events
        .filter((event) => event.name === "solid_objects.message.failed")
        .map(({ attributes }) => ({
          retryable: attributes.retryable,
          outcome: attributes.outcome,
        })),
    ).toEqual(
      expect.arrayContaining([
        { retryable: true, outcome: "retrying" },
        { retryable: true, outcome: "dead" },
      ]),
    )
    expect(
      events.find((event) => event.name === "solid_objects.mailbox.depth")?.attributes,
    ).toMatchObject({ truncated: true, depth: null })
    expect(JSON.stringify(events)).not.toContain("private")
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
  it("isolates a failing sink even when its logger also fails", async () => {
    const fail = () => {
      throw new Error("private sink error")
    }
    runtime = configuredRuntime({
      instrumentation: fail,
      logger: { debug: fail, info: fail, warn: fail, error: fail },
    })
    await runtime.install()
    expect(await InstrumentedActor.ref("safe").update({ secret: "committed" })).toBe(
      "result:committed",
    )
  })

  it("adds common correlation and bounded metric labels", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      instrumentation: (event) => {
        events.push(event)
      },
    })
    await runtime.install()
    await InstrumentedActor.ref("one").update({ secret: "private" })
    const completed = events.find((event) => event.name === "solid_objects.message.completed")!
    expect(completed).toMatchObject({
      schemaVersion: 1,
      adapter: runtime.settings.database.family,
      actorType: InstrumentedActor.actorType,
      actorId: "one",
      attempt: 1,
      incarnation: expect.any(String),
      messageId: expect.any(String),
    })
    expect(completed.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "solid_objects.events",
          kind: "counter",
          unit: "1",
          value: 1,
        }),
      ]),
    )
    expect(JSON.stringify(completed.metrics)).not.toContain('"actorId"')
  })

  it("authorizes bounded diagnostics and local observers before accessing an actor", async () => {
    runtime = configuredRuntime({
      authorizeAdministration: ({ authorizationContext }) => authorizationContext === "operator",
    })
    await runtime.install()
    const reference = InstrumentedActor.ref("diagnostics")
    await expect(reference.diagnostics()).rejects.toMatchObject({ name: "Unauthorized" })
    await expect(reference.observe({ onEvent: () => {} })).rejects.toMatchObject({
      name: "Unauthorized",
    })
    const events: InstrumentationEvent[] = []
    const stop = await reference.on("message.enqueued", {
      authorizationContext: "operator",
      onEvent: (event) => {
        events.push(event)
      },
    })
    await reference.send.update({ secret: "first-secret" })
    await reference.send.update({ secret: "second-secret" })
    await InstrumentedActor.ref("other").send.update({ secret: "other-secret" })
    expect(events).toHaveLength(2)
    stop()
    await reference.send.update({ secret: "third-secret" })
    expect(events).toHaveLength(2)
    const summary = await reference.diagnostics({ authorizationContext: "operator", limit: 1 })
    expect(summary.mailbox).toMatchObject({ sampled: 1, truncated: true })
    expect(summary.outbox.sampled).toBe(0)
    expect(JSON.stringify(summary)).not.toContain("secret")
    expect(Object.isFrozen(summary.mailbox)).toBe(true)
    await expect(
      reference.diagnostics({ authorizationContext: "operator", limit: 101 }),
    ).rejects.toThrow(RangeError)
  })

  it("observes retries, dead letters, snapshots, reminders, outboxes and realtime", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      maxAttempts: 2,
      retryDelayMilliseconds: () => 1,
      authorizeSubscription: () => true,
      instrumentation: (event) => {
        events.push(event)
      },
    })
    await runtime.install()
    runtime.registerEffect("telemetry-effect", () => "provider-private")
    const reference = InstrumentedActor.ref("lifecycle")
    await expect(reference.fail()).rejects.toMatchObject({ name: "MessageFailed" })
    await reference.arrange()
    const summary = await reference.diagnostics()
    expect(summary.outbox.sampled).toBe(1)
    expect(summary.reminders.sampled).toBe(1)
    await runtime.effectWorker().runUntilIdle()
    await runtime.reminderScheduler().runOnce()
    await reference.snapshot()
    const session = runtime.realtime.connect({ authorizationContext: "allowed", send: () => {} })
    await session.receive({
      version: 1,
      action: "subscribe",
      actorType: reference.actorType,
      actorId: reference.actorId,
    })
    session.close()
    expectPortableEvents(events, ["realtime.connected", "realtime.disconnected"])
    expect(events.map((event) => event.name)).toEqual(
      expect.arrayContaining([
        "solid_objects.activation.started",
        "solid_objects.activation.completed",
        "solid_objects.message.retry",
        "solid_objects.dead_letter.created",
        "solid_objects.reminder.enqueued",
        "solid_objects.outbox.age",
        "solid_objects.snapshot.read",
        "solid_objects.realtime.connected",
        "solid_objects.realtime.disconnected",
      ]),
    )
    expect(
      events.find((event) => event.name === "solid_objects.reminder.enqueued")?.metrics,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "solid_objects.reminder.lateness", unit: "ms" }),
      ]),
    )
    expect(JSON.stringify(events)).not.toContain("provider-private")
    expect(JSON.stringify(events)).not.toContain("reminder-private")
  })

  it("rejects observers without an onEvent callback", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const reference = InstrumentedActor.ref("callbackless")

    await expect(reference.observe({} as never)).rejects.toThrow(TypeError)
    await expect(reference.on("message.completed", {} as never)).rejects.toThrow(TypeError)
  })

  it("accepts at most 1000 local observers", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const reference = InstrumentedActor.ref("observer-limit")
    const stops = await Promise.all(
      Array.from({ length: 1000 }, () => reference.observe({ onEvent: () => {} })),
    )

    const error = await reference.observe({ onEvent: () => {} }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RangeError)
    expect(error).toHaveProperty("message", "at most 1000 local observers may be registered")
    stops.pop()?.()
    stops.push(await reference.observe({ onEvent: () => {} }))
    for (const stop of stops) stop()
  })

  it("removes local observers when the runtime closes", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const closed = runtime
    const identity = { actorType: InstrumentedActor.actorType, actorId: "closed-observer" }
    const events: InstrumentationEvent[] = []
    await InstrumentedActor.ref(identity.actorId).observe({
      onEvent: (event) => {
        events.push(event)
      },
    })
    closed.emitInstrumentation("custom", identity)

    await closed.close()
    runtime = undefined
    closed.emitInstrumentation("custom", identity)

    expect(events).toHaveLength(1)
  })

  it("isolates asynchronous sinks and rejects unknown metadata", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      instrumentation: (event) => {
        events.push(event)
      },
    })
    await runtime.install()
    const reference = InstrumentedActor.ref("async")
    const stop = await reference.observe({
      onEvent: async () => {
        throw new Error("exporter-private")
      },
    })
    expect(await reference.update({ secret: "committed" })).toBe("result:committed")
    runtime.emitInstrumentation("custom", {
      actorId: "async",
      arguments: "private",
      state: { secret: "private" },
      response: "private",
      password: "private",
    })
    expect(events.at(-1)?.attributes).toEqual({ actorId: "async" })
    stop()
  })

  it("reports failed durable recovery callbacks in diagnostics", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      instrumentation: (event) => {
        events.push(event)
      },
    })
    await runtime.install()
    const reference = InstrumentedActor.ref("recovery")
    await runtime.enqueueInternalMessage({
      actorType: reference.actorType,
      actorId: reference.actorId,
      operation: "fail",
      idempotencyKey: "effect:test:recovery",
    })
    await runtime.worker().runUntilIdle()
    expect((await reference.diagnostics()).recoveryFailures.sampled).toBe(1)
    expectPortableEvents(events, ["recovery.failed"])
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configure({
    database: process.env.SOLID_OBJECTS_DATABASE_URL?.startsWith("postgresql:")
      ? postgresql({ connectionString: process.env.SOLID_OBJECTS_DATABASE_URL })
      : sqlite({ path: ":memory:" }),
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

import { env, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { createRuntime, durableObjects } from "../../src/cloudflare/index.js"
import { Counter } from "./worker.js"

const runtime = () => createRuntime({ backend: durableObjects({ namespace: env.ACTORS }) })
const authorizationContext = "allowed"

describe("Durable Objects runtime", () => {
  it("runs portable references and snapshots with durable state", async () => {
    const reference = runtime().ref(Counter, "counter")
    expect(await reference.with({ authorizationContext }).increment({ amount: 2 })).toBe(2)
    expect(await reference.with({ authorizationContext }).doubled).toBe(4)
    const stub = env.ACTORS.getByName(JSON.stringify(["Counter", "counter"]))
    await evictDurableObject(stub)
    expect(await reference.snapshot({ authorizationContext })).toEqual({ count: 2, doubled: 4 })
  })

  it("serializes turns across awaits", async () => {
    const reference = runtime().ref(Counter, "concurrent").with({ authorizationContext })
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reference.incrementAfterAwait()),
    )
    expect(results.sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it("denies unauthenticated calls and deduplicates accepted work", async () => {
    const reference = runtime().ref(Counter, "idempotent")
    await expect(reference.increment()).rejects.toMatchObject({ name: "Unauthorized" })
    const options = { authorizationContext, idempotencyKey: "one" }
    expect(await reference.with(options).increment()).toBe(1)
    expect(await reference.with(options).increment()).toBe(1)
    await expect(reference.with(options).increment({ amount: 2 })).rejects.toMatchObject({
      name: "IdempotencyConflict",
    })
  })

  it("rolls back rejected and retried turns", async () => {
    const reference = runtime().ref(Counter, "retry").with({ authorizationContext })
    await expect(reference.rejectChange()).rejects.toMatchObject({
      name: "Rejected",
      code: "unavailable",
    })
    expect(await reference.retry()).toBe(1)
    expect(await reference.count).toBe(1)
  })

  it("drives reminders, effects, and cross-actor intents", async () => {
    const source = runtime().ref(Counter, "source").with({ authorizationContext })
    await source.arm({ at: Date.now() })
    await source.effect()
    await source.forward({ target: "destination" })
    const sourceStub = env.ACTORS.getByName(JSON.stringify(["Counter", "source"]))
    for (let attempt = 0; attempt < 10; attempt += 1) await runDurableObjectAlarm(sourceStub)
    expect((await runtime().ref(Counter, "source").snapshot({ authorizationContext })).count).toBe(
      11,
    )
    expect(await runtime().ref(Counter, "destination").with({ authorizationContext }).count).toBe(1)
  })

  it("cancels reminders before the alarm fires", async () => {
    const reference = runtime().ref(Counter, "cancelled").with({ authorizationContext })
    await reference.arm({ at: Date.now() + 60_000 })
    expect(await remainingReminders("cancelled")).toEqual(["increment"])

    await reference.disarm()
    expect(await remainingReminders("cancelled")).toEqual([])

    const stub = env.ACTORS.getByName(JSON.stringify(["Counter", "cancelled"]))
    for (let attempt = 0; attempt < 5; attempt += 1) await runDurableObjectAlarm(stub)
    expect(await runtime().ref(Counter, "cancelled").with({ authorizationContext }).count).toBe(0)
  })

  it("reads its own schedule inside a durable object", async () => {
    const reference = runtime().ref(Counter, "reads-schedule").with({ authorizationContext })
    expect(await reference.readArmed()).toBeNull()

    await reference.arm({ at: Date.now() + 60_000 })

    expect(await reference.readArmed()).toEqual({ name: "increment", interval: null })
  })

  it("cancels one keyed reminder and every key of an operation", async () => {
    const reference = runtime().ref(Counter, "keyed-cancel").with({ authorizationContext })
    await reference.armKeyed({ at: Date.now() + 60_000, keys: ["a", "b", "c"] })
    await reference.disarmKey({ key: "b" })
    expect(await remainingReminders("keyed-cancel")).toEqual(["increment:a", "increment:c"])

    await reference.disarmAll()
    expect(await remainingReminders("keyed-cancel")).toEqual([])
  })

  it("retains a recoverable accepted message after caller timeout", async () => {
    const reference = runtime().ref(Counter, "delayed")
    const message = await reference.send
      .with({ authorizationContext, availableAt: new Date(Date.now() + 60_000) })
      .increment()
    await expect(
      message.wait({ authorizationContext, timeoutMilliseconds: 5 }),
    ).rejects.toMatchObject({ name: "SyncTimeout", messageReference: { id: message.id } })
    expect(
      (
        await runtime().lookupMessage({
          actorType: "Counter",
          actorId: "delayed",
          requestId: message.requestId,
          authorizationContext,
        })
      )?.id,
    ).toBe(message.id)
    await runInDurableObject(
      env.ACTORS.getByName(JSON.stringify(["Counter", "delayed"])),
      async (_object, state) => {
        expect(await state.storage.getAlarm()).not.toBeNull()
      },
    )
  })
})

async function remainingReminders(actorId: string): Promise<string[]> {
  const stub = env.ACTORS.getByName(JSON.stringify(["Counter", actorId]))
  return runInDurableObject(stub, (_object, state) =>
    state.storage.sql
      .exec<{ name: string }>("SELECT name FROM reminders ORDER BY name")
      .toArray()
      .map((row) => row.name),
  )
}

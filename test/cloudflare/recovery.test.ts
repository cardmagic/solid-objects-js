import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { createRuntime, durableObjects } from "../../src/cloudflare/index.js"
import type { Instance, Message } from "../../src/cloudflare/records.js"
import { Counter, VersionedCounter, gates, deliveries } from "./worker.js"

const authorizationContext = "allowed"
const backend = () => durableObjects({ namespace: env.ACTORS, sessions: env.SESSIONS })
const runtime = () => createRuntime({ backend: backend() })
const stub = (actorId: string) => env.ACTORS.getByName(JSON.stringify(["Counter", actorId]))

describe("Cloudflare recovery and fencing", () => {
  it("migrates stored state on activation and rejects a newer stored version", async () => {
    const reference = runtime().ref(VersionedCounter, "migration")
    const actor = env.ACTORS.getByName(JSON.stringify(["VersionedCounter", "migration"]))
    await reference.with({ authorizationContext }).increment()
    await runInDurableObject(actor, (_object, state) => {
      const instance = JSON.parse(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'instance'")
          .one().value,
      ) as Instance
      instance.stateVersion = 1
      state.storage.sql.exec(
        "UPDATE metadata SET value = ? WHERE key = 'instance'",
        JSON.stringify(instance),
      )
    })
    await evictDurableObject(actor)
    expect(await reference.with({ authorizationContext }).increment()).toBe(12)
    await runInDurableObject(actor, (_object, state) => {
      const instance = JSON.parse(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'instance'")
          .one().value,
      ) as Instance
      expect(instance.stateVersion).toBe(2)
      instance.stateVersion = 3
      state.storage.sql.exec(
        "UPDATE metadata SET value = ? WHERE key = 'instance'",
        JSON.stringify(instance),
      )
    })
    await evictDurableObject(actor)
    await expect(reference.snapshot({ authorizationContext })).rejects.toMatchObject({
      name: "StateMigrationError",
    })
    await expect(reference.with({ authorizationContext }).increment()).rejects.toMatchObject({
      name: "ActorSetupFailed",
      setupError: { name: "StateMigrationError" },
    })
  })

  it("coalesces missed recurring reminders and preserves the next deadline", async () => {
    const reference = runtime().ref(Counter, "recurring")
    await reference
      .with({ authorizationContext })
      .armRecurring({ at: Date.now() - 120_000, interval: 60_000, missed: "latest" })
    await expect
      .poll(() => reference.snapshot({ authorizationContext }).then((snapshot) => snapshot.count))
      .toBe(1)
    const reminders = await runtime()
      .actorAdministration({ actorType: "Counter", actorId: "recurring", authorizationContext })
      .reminders()
    expect(reminders).toMatchObject([{ status: "scheduled" }])
    expect(Number((reminders as { at: number }[])[0]!.at)).toBeGreaterThan(Date.now())
  })

  it("rolls back a result that exceeds the aggregate SQLite record limit", async () => {
    const reference = runtime().ref(Counter, "oversized-record")
    await expect(
      reference
        .with({ authorizationContext, timeoutMilliseconds: 500 })
        .echo({ value: "x".repeat(1_010_000) }),
    ).rejects.toMatchObject({ name: "MessageFailed", details: { name: "PayloadTooLarge" } })
    expect((await reference.snapshot({ authorizationContext })).count).toBe(0)
  })

  it("rejects a stale in-flight commit while another identity continues", async () => {
    const reference = runtime().ref(Counter, "in-flight")
    const message = await reference.send.with({ authorizationContext }).pause()
    await expect.poll(() => gates.has("in-flight")).toBe(true)
    try {
      expect(
        await runtime().ref(Counter, "independent").with({ authorizationContext }).increment(),
      ).toBe(1)
      await reference.destroy({ authorizationContext })
    } finally {
      await runInDurableObject(stub("in-flight"), () => gates.get("in-flight")!())
    }
    expect(await reference.with({ authorizationContext }).increment()).toBe(1)
    await expect(message.result({ authorizationContext })).rejects.toMatchObject({
      name: "ActorDestroyed",
    })
  })

  it("does not hold actor turns behind a slow effect", async () => {
    const reference = runtime().ref(Counter, "slow-effect").with({ authorizationContext })
    await reference.slowEffect()
    await expect.poll(() => gates.has("slow-effect")).toBe(true)
    try {
      expect(await reference.increment()).toBe(1)
    } finally {
      await runInDurableObject(stub("slow-effect"), () => gates.get("slow-effect")!())
    }
    await expect
      .poll(() =>
        runtime()
          .ref(Counter, "slow-effect")
          .snapshot({ authorizationContext })
          .then((snapshot) => snapshot.count),
      )
      .toBe(11)
  })

  it("uses a stable effect ID across retries and delivers its callback once", async () => {
    await runtime().ref(Counter, "repeat-effect").with({ authorizationContext }).repeatedEffect()
    await expect
      .poll(() =>
        runtime()
          .ref(Counter, "repeat-effect")
          .snapshot({ authorizationContext })
          .then((snapshot) => snapshot.count),
      )
      .toBe(10)
    const outbox = await runInDurableObject(stub("repeat-effect"), (_object, state) =>
      state.storage.sql.exec<{ id: string }>("SELECT id FROM outboxes WHERE kind = 'effect'").one(),
    )
    expect(deliveries.get(outbox.id)).toBe(2)
  })

  it("deduplicates destination acceptance after an outbound acknowledgement is lost", async () => {
    await runtime()
      .ref(Counter, "lost-ack-source")
      .with({ authorizationContext })
      .forward({ target: "lost-ack" })
    await expect
      .poll(async () =>
        runInDurableObject(
          stub("lost-ack-source"),
          (_object, state) =>
            state.storage.sql
              .exec<{ status: string }>("SELECT status FROM outboxes WHERE kind = 'outbound'")
              .one().status,
        ),
      )
      .toBe("completed")
    expect(
      (await runtime().ref(Counter, "lost-ack").snapshot({ authorizationContext })).count,
    ).toBe(1)
  })

  it("rolls back state and every staged outbox on failure", async () => {
    await expect(
      runtime().ref(Counter, "rollback").with({ authorizationContext }).failWithIntents(),
    ).rejects.toMatchObject({ name: "MessageFailed" })
    const counts = await runInDurableObject(stub("rollback"), (_object, state) => ({
      outboxes: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM outboxes")
        .one().count,
      reminders: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM reminders")
        .one().count,
    }))
    expect(counts).toEqual({ outboxes: 0, reminders: 0 })
    expect(
      (await runtime().ref(Counter, "rollback").snapshot({ authorizationContext })).count,
    ).toBe(0)
  })

  it("recovers ambiguous acceptance by request ID without repeating work", async () => {
    const client = createRuntime({
      backend: durableObjects({
        namespace: {
          getByName: (name) => ({
            request: async (request) => {
              const reply = await env.ACTORS.getByName(name).request(request)
              if (request.method === "enqueue" && reply.ok)
                throw new Error("connection lost after durable acceptance")
              return reply
            },
          }),
        },
      }),
    })
    let requestId = ""
    try {
      await client.ref(Counter, "ambiguous").with({ authorizationContext }).increment()
    } catch (error) {
      expect(error).toMatchObject({ name: "EnqueueOutcomeUnknown" })
      requestId = (error as { details: { requestId: string } }).details.requestId
    }
    expect(requestId).not.toBe("")
    const recovered = await runtime().lookupMessage({
      actorType: "Counter",
      actorId: "ambiguous",
      requestId,
      authorizationContext,
    })
    expect(await recovered!.wait({ authorizationContext })).toBe(1)
    await expect(
      runtime().lookupMessage({ actorType: "Counter", actorId: "ambiguous", requestId }),
    ).rejects.toMatchObject({ name: "Unauthorized" })
  })

  it("recovers a claimed turn on activation using only its alarm", async () => {
    const reference = runtime().ref(Counter, "interrupted")
    const message = await reference.send
      .with({ authorizationContext, availableAt: new Date(Date.now() + 60_000) })
      .increment()
    await runInDurableObject(stub("interrupted"), async (_object, state) => {
      const row = state.storage.sql
        .exec<{ record: string }>("SELECT record FROM messages WHERE id = ?", message.id)
        .one()
      const stored = JSON.parse(row.record) as Message
      stored.status = "claimed"
      stored.attempt = 1
      stored.availableAt = Date.now()
      state.storage.sql.exec(
        "UPDATE messages SET status = 'claimed', available_at = ?, record = ? WHERE id = ?",
        stored.availableAt,
        JSON.stringify(stored),
        stored.id,
      )
      await state.storage.setAlarm(Date.now() + 1)
    })
    await evictDurableObject(stub("interrupted"))
    await runDurableObjectAlarm(stub("interrupted"))
    expect(await message.wait({ authorizationContext })).toBe(1)
  })

  it("keeps sequences exact above JavaScript's safe integer range", async () => {
    const reference = runtime().ref(Counter, "large-sequence")
    await reference.with({ authorizationContext }).increment()
    await runInDurableObject(stub("large-sequence"), (_object, state) => {
      const row = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'instance'")
        .one()
      const instance = JSON.parse(row.value) as Instance
      instance.nextSequence = "9007199254740993"
      state.storage.sql.exec(
        "UPDATE metadata SET value = ? WHERE key = 'instance'",
        JSON.stringify(instance),
      )
    })
    const first = await reference.send.with({ authorizationContext }).increment()
    const second = await reference.send.with({ authorizationContext }).increment()
    expect(first.sequence).toBe(9007199254740993n)
    expect(second.sequence).toBe(first.sequence + 1n)
    expect(await second.wait({ authorizationContext })).toBe(3)
  })

  it("keeps runtime context across awaits and rejects actor call cycles", async () => {
    const source = runtime().ref(Counter, "async-source").with({ authorizationContext })
    await source.forwardAfterAwait({ target: "async-target" })
    await runDurableObjectAlarm(stub("async-source"))
    await expect
      .poll(() =>
        runtime()
          .ref(Counter, "async-target")
          .snapshot({ authorizationContext })
          .then((snapshot) => snapshot.count),
      )
      .toBe(1)
    await expect(source.forbiddenCall()).rejects.toMatchObject({
      name: "MessageFailed",
      details: { name: "ActorCallCycle" },
    })
  })

  it("retains dead letters, pauses later work, and rejects unsupported commits", async () => {
    const reference = runtime().ref(Counter, "dead")
    await expect(reference.with({ authorizationContext }).failPermanently()).rejects.toMatchObject({
      name: "MessageFailed",
    })
    const waiting = await reference.send.with({ authorizationContext }).increment()
    await expect(
      waiting.wait({ authorizationContext, timeoutMilliseconds: 10 }),
    ).rejects.toMatchObject({ name: "SyncTimeout" })
    const administration = runtime().actorAdministration({
      actorType: "Counter",
      actorId: "dead",
      authorizationContext,
    })
    expect(await administration.deadLetters()).toMatchObject({ messages: [{ status: "dead" }] })
    expect((await reference.snapshot({ authorizationContext })).count).toBe(0)
    await expect(
      runtime().ref(Counter, "commit").with({ authorizationContext }).commitToDatabase(),
    ).rejects.toMatchObject({ name: "MessageFailed", details: { name: "UnsupportedCapability" } })
    expect(() => runtime().run()).toThrow(/does not support/)
  })

  it("fences old references when an actor is destroyed and recreated", async () => {
    const reference = runtime().ref(Counter, "recreated")
    const old = await reference.send.with({ authorizationContext }).increment()
    await old.wait({ authorizationContext })
    const before = await runtime().snapshotWithIncarnation(reference, { authorizationContext })
    expect(await reference.destroy({ authorizationContext })).toBe(true)
    expect(await reference.with({ authorizationContext }).increment()).toBe(1)
    await expect(old.result({ authorizationContext })).rejects.toMatchObject({
      name: "ActorDestroyed",
    })
    expect(
      (await runtime().snapshotWithIncarnation(reference, { authorizationContext })).instanceId,
    ).not.toBe(before.instanceId)
  })

  it("stops alarms after retention removes completed work", async () => {
    await runtime().ref(Counter, "pruned").with({ authorizationContext }).increment()
    await runInDurableObject(stub("pruned"), (_object, state) => {
      state.storage.sql.exec("UPDATE messages SET completed_at = 0")
    })
    await runDurableObjectAlarm(stub("pruned"))
    const alarm = await runInDurableObject(stub("pruned"), (_object, state) =>
      state.storage.getAlarm(),
    )
    expect(alarm).toBeNull()
  })

  it("continues bounded receipt cleanup using its saved alarm", async () => {
    const reference = runtime().ref(Counter, "receipt-cleanup")
    const message = await reference.send.with({ authorizationContext }).increment()
    await message.wait({ authorizationContext })
    await runInDurableObject(stub("receipt-cleanup"), (_object, state) => {
      for (let index = 0; index < 1_002; index += 1)
        state.storage.sql.exec(
          "INSERT INTO receipts(request_id, message_id) VALUES (?, ?)",
          `alias-${index}`,
          message.id,
        )
      state.storage.sql.exec("UPDATE messages SET completed_at = 0")
    })
    await runDurableObjectAlarm(stub("receipt-cleanup"))
    await expect
      .poll(() =>
        runInDurableObject(
          stub("receipt-cleanup"),
          (_object, state) =>
            state.storage.sql
              .exec<{ count: number }>("SELECT COUNT(*) AS count FROM receipts")
              .one().count,
        ),
      )
      .toBe(0)
    await expect
      .poll(() =>
        runInDurableObject(stub("receipt-cleanup"), (_object, state) => state.storage.getAlarm()),
      )
      .toBeNull()
  })
})

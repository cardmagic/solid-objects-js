import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import {
  ActorDestroyed,
  IdempotencyConflict,
  InvalidRejectionCode,
  MessageFailed,
  NonRetryableError,
  QueryMutatedState,
  Rejected,
  SyncInsideTransaction,
  Unauthorized,
} from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"

class ReliableCounter extends Actor {
  static override readonly actorType = "ReliableCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }

  incrementThenFail(): void {
    this.count += 1
    throw new Error("turn failed")
  }

  rejectIncrement(): void {
    this.count += 1
    this.reject("not_allowed", {
      message: "Increment is not allowed",
      details: { count: this.count },
    })
  }

  rejectCamelCase(): void {
    this.reject("roomNotFound", { message: "No such room" })
  }

  rejectInvalidCode({ code }: { code: string }): void {
    this.reject(code, { message: "Invalid rejection code" })
  }

  resultObject(): { nested: { count: number } } {
    return { nested: { count: this.count } }
  }

  messageMetadata(): {
    requestId: string
    idempotencyKey: string | null
    enqueuedAt: string
  } {
    const message = this.currentMessage
    if (!message) throw new Error("message context is unavailable")
    return {
      requestId: message.requestId,
      idempotencyKey: message.idempotencyKey,
      enqueuedAt: message.enqueuedAt.toISOString(),
    }
  }
}

class MutatingQuery extends Actor {
  static override readonly actorType = "MutatingQuery"

  count = 0

  get invalid(): number {
    this.count += 1
    return this.count
  }
}

class SideEffectingQuery extends Actor {
  static override readonly actorType = "SideEffectingQuery"

  get invalid(): number {
    this.emit("unexpected")
    return 1
  }
}

class SideEffectingObservable extends Actor {
  static override readonly actorType = "SideEffectingObservable"

  increment(): void {}

  override observables(): Record<string, unknown> {
    this.emit("unexpected")
    return {}
  }
}

class Target extends Actor {
  static override readonly actorType = "CorrectnessTarget"

  received = 0

  receive(): void {
    this.received += 1
  }
}

class InvalidSource extends Actor {
  static override readonly actorType = "InvalidSource"

  async sendWithoutStaging(): Promise<void> {
    await Target.ref("target").send.receive()
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("durable invocation correctness", () => {
  it("denies messages and queries when no authorization policy is configured", async () => {
    runtime = configure({ database: sqlite({ path: ":memory:" }) })
    await runtime.install()
    const counter = ReliableCounter.ref("denied")

    await expect(counter.increment()).rejects.toBeInstanceOf(Unauthorized)
    await expect(counter.count).rejects.toBeInstanceOf(Unauthorized)
  })

  it("reauthorizes durable message status, results, and waits", async () => {
    runtime = configuredRuntime({
      authorizeMessage: ({ authorizationContext }) => authorizationContext === "allowed",
    })
    await runtime.install()
    const message = await ReliableCounter.ref("protected")
      .send.with({
        authorizationContext: "allowed",
      })
      .increment()

    await expect(message.status()).rejects.toBeInstanceOf(Unauthorized)
    expect(await message.status({ authorizationContext: "allowed" })).toBe("ready")
    await runtime.worker().runUntilIdle()
    await expect(message.result()).rejects.toBeInstanceOf(Unauthorized)
    expect(await message.result({ authorizationContext: "allowed" })).toBe(1)
    expect(await message.wait({ authorizationContext: "allowed" })).toBe(1)
  })

  it("deduplicates matching idempotency keys and rejects conflicting reuse", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = ReliableCounter.ref("idempotent")

    const first = await counter.send.with({ idempotencyKey: "request-1" }).increment({ amount: 2 })
    const duplicate = await counter.send
      .with({ idempotencyKey: "request-1" })
      .increment({ amount: 2 })

    expect(duplicate.id).toBe(first.id)
    expect(first.requestId).not.toBe("request-1")
    await expect(
      counter.send.with({ idempotencyKey: "request-1" }).increment({ amount: 3 }),
    ).rejects.toBeInstanceOf(IdempotencyConflict)
    await expect(
      counter.with({ idempotencyKey: "request-1" }).increment({ amount: 2 }),
    ).rejects.toBeInstanceOf(IdempotencyConflict)
  })

  it("exposes request identity and idempotency separately in actor context", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    const result = await ReliableCounter.ref("metadata")
      .with({ idempotencyKey: "metadata-once" })
      .messageMetadata()

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.idempotencyKey).toBe("metadata-once")
    expect(new Date(result.enqueuedAt).getTime()).not.toBeNaN()
  })

  it("deduplicates an idempotent request even when the mailbox is full", async () => {
    runtime = configuredRuntime({ maxMailboxLength: 1 })
    await runtime.install()
    const counter = ReliableCounter.ref("full-idempotent")

    const first = await counter.send.with({ idempotencyKey: "request-1" }).increment()
    const duplicate = await counter.send.with({ idempotencyKey: "request-1" }).increment()

    expect(duplicate.id).toBe(first.id)
  })

  it("scopes idempotency keys to an actor identity", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    const first = await ReliableCounter.ref("first")
      .send.with({
        idempotencyKey: "shared-request",
      })
      .increment()
    const second = await ReliableCounter.ref("second")
      .send.with({
        idempotencyKey: "shared-request",
      })
      .increment()

    expect(second.id).not.toBe(first.id)
  })

  it("rolls state back when a turn fails", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()
    const counter = ReliableCounter.ref("rollback")
    const failed = await counter.send.incrementThenFail()

    await runtime.worker().runUntilIdle()

    expect(await failed.status()).toBe("dead")
    expect(await counter.count).toBe(0)
  })

  it("rolls state back and returns structured domain rejections", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = ReliableCounter.ref("rejected")

    const rejection = await counter.rejectIncrement().catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(Rejected)
    expect(rejection).toMatchObject({
      code: "not_allowed",
      details: { count: 1 },
    })
    expect((rejection as Rejected).messageId).toBeTypeOf("string")
    expect(await counter.count).toBe(0)
  })

  it("accepts camelCase rejection codes", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    const rejection = await ReliableCounter.ref("camel-case")
      .rejectCamelCase()
      .catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(Rejected)
    expect(rejection).toMatchObject({ code: "roomNotFound", message: "No such room" })
  })

  it.each(["room not found", "1roomNotFound"])(
    "fails invalid rejection code %j without retrying",
    async (code) => {
      runtime = configuredRuntime({ maxAttempts: 3 })
      await runtime.install()

      const failure = await ReliableCounter.ref("invalid-rejection")
        .rejectInvalidCode({ code })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(MessageFailed)
      expect(failure).toMatchObject({
        details: {
          name: "InvalidRejectionCode",
          message: expect.stringContaining(code),
        },
      })
      const message = await runtime.repository.findMessage((failure as MessageFailed).messageId)
      expect(Number(message?.attempt_count)).toBe(1)
      expect(InvalidRejectionCode.prototype).toBeInstanceOf(NonRetryableError)
    },
  )

  it("recovers terminal failures through message results", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()
    const counter = ReliableCounter.ref("result-failures")
    const rejected = await counter.send.rejectIncrement()
    const failed = await counter.send.incrementThenFail()

    await runtime.worker().runUntilIdle()

    await expect(rejected.result()).rejects.toBeInstanceOf(Rejected)
    const failure = await failed.result().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MessageFailed)
    expect(failure).toMatchObject({
      message: "actor message failed permanently",
      messageId: failed.id,
      details: { name: "Error", message: "turn failed" },
    })
  })

  it("raises a structured terminal failure from direct invocation", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()

    const failure = await ReliableCounter.ref("direct-failure")
      .incrementThenFail()
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(MessageFailed)
    expect(failure).toMatchObject({
      message: "actor message failed permanently",
      messageId: expect.any(String),
      details: { name: "Error", message: "turn failed" },
    })
  })

  it("raises ActorDestroyed when an authorized actor disappears while waiting", async () => {
    let authorizationCalls = 0
    let waitingAuthorizationStarted: (() => void) | undefined
    let continueAuthorization: (() => void) | undefined
    const authorizationStarted = new Promise<void>((resolve) => {
      waitingAuthorizationStarted = resolve
    })
    const authorizationCanContinue = new Promise<void>((resolve) => {
      continueAuthorization = resolve
    })
    runtime = configuredRuntime({
      authorizeMessage: async () => {
        authorizationCalls += 1
        if (authorizationCalls !== 2) return true
        waitingAuthorizationStarted?.()
        await authorizationCanContinue
        return true
      },
    })
    await runtime.install()
    const counter = ReliableCounter.ref("destroyed-wait")
    const message = await counter.send.increment()
    const result = message.wait({ timeoutMilliseconds: 1_000 })
    await authorizationStarted

    await counter.destroy()
    continueAuthorization?.()

    await expect(result).rejects.toBeInstanceOf(ActorDestroyed)
  })

  it("rejects getters that mutate persisted state", async () => {
    runtime = configuredRuntime({ maxAttempts: 3 })
    await runtime.install()

    const query = MutatingQuery.ref("bad")
    await expect(query.invalid).rejects.toMatchObject({
      details: { message: "query invalid mutated actor state" },
    })
    const message = await runtime.settings.database.connection((connection) =>
      connection.get<{
        attempt_count: number | bigint
      }>(`SELECT attempt_count FROM ${runtime?.repository.table("messages")}`),
    )
    expect(Number(message?.attempt_count)).toBe(1)
  })

  it("rejects queries that stage durable work", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()

    await expect(SideEffectingQuery.ref("bad").invalid).rejects.toMatchObject({
      details: { message: "query invalid staged durable work" },
    })
    const effect = await runtime.settings.database.connection((connection) =>
      connection.get(`SELECT id FROM ${runtime?.repository.table("effects")}`),
    )
    expect(effect).toBeUndefined()
  })

  it("rejects snapshot getters that mutate state", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await expect(MutatingQuery.ref("snapshot").snapshot()).rejects.toBeInstanceOf(QueryMutatedState)
    expect(await MutatingQuery.ref("snapshot").count).toBe(0)
  })

  it("rejects observables that mutate state or stage durable work", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()

    await expect(SideEffectingObservable.ref("bad").increment()).rejects.toMatchObject({
      details: { message: "observables must not mutate actor state or stage durable work" },
    })
  })

  it("returns deeply frozen result values", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    const result = await ReliableCounter.ref("readonly").resultObject()

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.nested)).toBe(true)
  })

  it("processes messages sequentially for one actor", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = ReliableCounter.ref("ordered")
    const first = await counter.send.increment({ amount: 2 })
    const second = await counter.send.increment({ amount: 3 })

    expect(await runtime.worker().runUntilIdle()).toBe(2)

    expect(await first.result()).toBe(2)
    expect(await second.result()).toBe(5)
  })

  it("preserves ordering with concurrent SQLite workers", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = ReliableCounter.ref("concurrent")
    const messages = await Promise.all(Array.from({ length: 20 }, () => counter.send.increment()))

    const processed = await Promise.all([
      runtime.worker().runUntilIdle(),
      runtime.worker().runUntilIdle(),
    ])

    expect(processed.reduce((total, count) => total + count, 0)).toBe(20)
    expect(await counter.count).toBe(20)
    expect(await Promise.all(messages.map((message) => message.result()))).toEqual(
      Array.from({ length: 20 }, (_value, index) => index + 1),
    )
  })

  it("requires actor code to use sendTo for transactional delivery", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()
    const message = await InvalidSource.ref("source").send.sendWithoutStaging()

    await runtime.worker().runUntilIdle()

    const stored = await runtime.repository.findMessage(message.id)
    expect(JSON.parse(stored?.error ?? "{}")).toMatchObject({
      name: "ActorCallCycle",
      message: expect.stringContaining("sendTo"),
    })
    expect(await Target.ref("target").received).toBe(0)
  })

  it("rejects synchronous invocation inside its database transaction before enqueue", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = ReliableCounter.ref("ambient-transaction")

    const error = await runtime.settings.database.transaction(async () => {
      try {
        await counter.increment()
      } catch (raised) {
        return raised
      }
      throw new Error("expected invocation to fail")
    })

    expect(error).toBeInstanceOf(SyncInsideTransaction)
    expect(error).toMatchObject({
      details: {
        actorType: ReliableCounter.actorType,
        actorId: "ambient-transaction",
        operation: "increment",
      },
    })
    const messages = await runtime.settings.database.connection((connection) =>
      connection.all(`SELECT id FROM ${runtime?.repository.table("messages")}`),
    )
    expect(messages).toEqual([])
  })

  it("rejects waiting for a message inside its database transaction", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const message = await ReliableCounter.ref("ambient-wait").send.increment()

    const error = await runtime.settings.database.transaction(async () => {
      try {
        await message.wait()
      } catch (raised) {
        return raised
      }
      throw new Error("expected wait to fail")
    })

    expect(error).toBeInstanceOf(SyncInsideTransaction)
    expect(error).toMatchObject({
      details: {
        actorType: ReliableCounter.actorType,
        actorId: "ambient-wait",
        operation: "increment",
      },
    })
    expect(await message.status()).toBe("ready")
  })

  it("does not retain transaction state in detached asynchronous work", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = ReliableCounter.ref("detached")
    let invokeAfterCommit: (() => Promise<number>) | undefined

    await runtime.settings.database.transaction(async () => {
      invokeAfterCommit = () => counter.increment()
    })

    await expect(invokeAfterCommit?.()).resolves.toBe(1)
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 2,
    ...overrides,
  })
}

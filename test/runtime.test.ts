import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { Actor } from "../src/actor.js"
import { configure, createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { UnknownOperation } from "../src/errors.js"
import type { MessageReference } from "../src/reference.js"

class Counter extends Actor {
  static override readonly actorType = "Counter"

  count = 0
  lastAuthorizationContext: string | null = null

  get doubled(): number {
    return this.count * 2
  }

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }

  recordOptions(argumentsValue: {
    authorizationContext: string
    timeoutMilliseconds: number
  }): void {
    this.lastAuthorizationContext = `${argumentsValue.authorizationContext}:${argumentsValue.timeoutMilliseconds}`
  }

  arm({ amount }: { amount: number }): void {
    this.schedule({
      at: new Date("2030-01-02T03:04:05.000Z"),
      everyMilliseconds: 60_000,
      missed: "all",
    }).increment!({ amount })
  }

  armUnknown(): void {
    this.schedule({ at: new Date("2030-01-02T03:04:05.000Z") }).missing!()
  }
}

class AuditLog extends Actor {
  static override readonly actorType = "AuditLog"

  events: string[] = []

  record({ eventName }: { eventName: string }): number {
    this.events = [...this.events, eventName]
    return this.events.length
  }
}

class Account extends Actor {
  static override readonly actorType = "Account"

  disable({ auditLogId }: { auditLogId: string }): void {
    this.sendTo(AuditLog.ref(auditLogId)).record({ eventName: "account_disabled" })
  }

  disableLater({ auditLogId }: { auditLogId: string }): void {
    this.sendTo(AuditLog.ref(auditLogId), {
      availableAt: new Date("2030-01-02T03:04:05.000Z"),
      idempotencyKey: "account-disabled",
    }).record({ eventName: "account_disabled" })
  }

  failAfterSending({ auditLogId }: { auditLogId: string }): void {
    this.sendTo(AuditLog.ref(auditLogId)).record({ eventName: "should_not_commit" })
    throw new Error("account turn failed")
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("typed actor references", () => {
  it("keeps createRuntime isolated while resolving actor references inside its turns", async () => {
    runtime = createRuntime(configuredSettings())
    runtime.register(Account)
    runtime.register(AuditLog)
    await runtime.install()

    await runtime.ref(Account, "account").disable({ auditLogId: "audit" })

    await expect(runtime.ref(AuditLog, "audit").events).resolves.toEqual(["account_disabled"])
  })

  it("invokes messages and reads fields and getters as committed queries", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = Counter.ref("primary")

    expect(await counter.increment({ amount: 3 })).toBe(3)
    expect(await counter.count).toBe(3)
    expect(await counter.doubled).toBe(6)

    expectTypeOf(counter.increment).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(counter).toHaveProperty("count").toEqualTypeOf<Promise<number>>()
    expectTypeOf(counter).not.toHaveProperty("async")
    expectTypeOf(counter).not.toHaveProperty("sync")
  })

  it("enqueues through send without creating a second sync API", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = Counter.ref("background")

    const message = await counter.send.increment({ amount: 4 })

    expectTypeOf(message).toEqualTypeOf<MessageReference<number>>()
    expect(await message.status()).toBe("ready")
    const stored = await runtime.settings.database.connection((connection) =>
      connection.get<{ operation: string; delivery_mode: string }>(
        `SELECT operation, delivery_mode FROM ${runtime?.repository.table("messages")} WHERE id = ?`,
        [message.id],
      ),
    )
    expect(stored).toEqual({ operation: "increment", delivery_mode: "async" })
    expect(await runtime.worker().runUntilIdle()).toBe(1)
    expect(await message.result()).toBe(4)
  })

  it("separates invocation options from actor arguments", async () => {
    const authorizationContexts: unknown[] = []
    runtime = configuredRuntime({
      authorizeMessage: ({ authorizationContext }) => {
        authorizationContexts.push(authorizationContext)
        return authorizationContext === "allowed"
      },
    })
    await runtime.install()
    const counter = Counter.ref("options")

    await counter
      .with({
        authorizationContext: "allowed",
        timeoutMilliseconds: 1_000,
      })
      .recordOptions({
        authorizationContext: "actor argument",
        timeoutMilliseconds: 42,
      })

    expect(authorizationContexts).toEqual(["allowed"])
    expect(await counter.lastAuthorizationContext).toBe("actor argument:42")
  })

  it("separates send options from actor arguments", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const counter = Counter.ref("send-options")
    const availableAt = new Date(Date.now() + 60_000)

    const message = await counter.send
      .with({
        availableAt,
        idempotencyKey: "increment-later",
      })
      .increment({ amount: 2 })

    expect(message.requestId).toBe("increment-later")
    expect(await message.status()).toBe("ready")
    const row = await runtime.settings.database.connection((connection) =>
      connection.get<{
        available_at_ms: number | bigint
      }>(
        `SELECT available_at_ms FROM ${runtime?.repository.table("ready_messages")} WHERE message_id = ?`,
        [message.id],
      ),
    )
    expect(Number(row?.available_at_ms)).toBe(availableAt.getTime())
  })
})

describe("actor-owned delivery", () => {
  it("stages actor-to-actor messages with the fluent operation shape", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const account = Account.ref("account-1")
    const auditLog = AuditLog.ref("global")

    await account.disable({ auditLogId: auditLog.actorId })
    expect(await runtime.worker().runUntilIdle()).toBe(1)

    expect(await auditLog.events).toEqual(["account_disabled"])
  })

  it("does not persist staged delivery when the source turn fails", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()
    const account = Account.ref("account-2")
    const auditLog = AuditLog.ref("global")
    const message = await account.send.failAfterSending({ auditLogId: auditLog.actorId })

    expect(await runtime.worker().runUntilIdle()).toBe(1)
    expect(await message.status()).toBe("dead")
    expect(await auditLog.events).toEqual([])
  })

  it("keeps outbound delivery options outside message arguments", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await Account.ref("account-3").disableLater({ auditLogId: "global" })

    const row = await runtime.settings.database.connection((connection) =>
      connection.get<{
        request_id: string
        available_at_ms: number | bigint
      }>(
        `SELECT messages.request_id, ready.available_at_ms
       FROM ${runtime?.repository.table("messages")} messages
       JOIN ${runtime?.repository.table("ready_messages")} ready ON ready.message_id = messages.id
       WHERE messages.actor_type = ?`,
        [AuditLog.actorType],
      ),
    )
    expect(row?.request_id).toBe("account-disabled")
    expect(Number(row?.available_at_ms)).toBe(new Date("2030-01-02T03:04:05.000Z").getTime())
  })
})

describe("actor reminders", () => {
  it("stages the selected message and its arguments", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await Counter.ref("scheduled").arm({ amount: 7 })

    const reminder = await runtime.settings.database.connection((connection) =>
      connection.get<{
        name: string
        arguments: string
        run_at_ms: number | bigint
        interval_ms: number | bigint
        missed_policy: string
      }>(`SELECT * FROM ${runtime?.repository.table("reminders")}`),
    )
    expect(reminder).toMatchObject({
      operation: "increment",
      arguments: JSON.stringify({ amount: 7 }),
      missed_policy: "all",
    })
    expect(Number(reminder?.run_at_ms)).toBe(new Date("2030-01-02T03:04:05.000Z").getTime())
    expect(Number(reminder?.interval_ms)).toBe(60_000)
  })

  it("rejects unknown reminder messages before persistence", async () => {
    runtime = configuredRuntime({ maxAttempts: 1 })
    await runtime.install()
    const message = await Counter.ref("invalid-reminder").send.armUnknown()

    expect(await runtime.worker().runUntilIdle()).toBe(1)
    expect(await message.status()).toBe("dead")
    const reminder = await runtime.settings.database.connection((connection) =>
      connection.get(`SELECT id FROM ${runtime?.repository.table("reminders")}`),
    )
    expect(reminder).toBeUndefined()
    expect(UnknownOperation).toBeDefined()
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configure(configuredSettings(overrides))
}

function configuredSettings(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsConfiguration {
  return {
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 2,
    ...overrides,
  }
}

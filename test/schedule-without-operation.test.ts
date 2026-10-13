import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { NonRetryableError, ScheduleWithoutOperation } from "../src/index.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"

const HOLD_MILLISECONDS = 600_000

function holdEnd(holds = 1): Date {
  return new Date(Date.now() + holds * HOLD_MILLISECONDS)
}

class Holder extends Actor {
  static override readonly actorType = "schedule-without-operation"

  status = "open"

  hold(): void {
    this.status = "held"
    this.schedule({ at: holdEnd(), key: "ada" }).expire()
  }

  holdWithoutOperation(): boolean {
    this.status = "held"
    this.schedule({ at: holdEnd(), key: "ada" })
    return true
  }

  holdWithOneOperationMissing(): boolean {
    this.status = "held"
    this.schedule({ at: holdEnd(), key: "ada" }).expire()
    this.schedule({ at: holdEnd(2), key: "grace" })
    return true
  }

  holdWithALateOperation(): void {
    const reminder = this.schedule({ at: holdEnd(), key: "ada" })
    this.status = "held"
    reminder.expire()
  }

  expire(): void {
    this.status = "open"
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

async function start(): Promise<SolidObjectsRuntime> {
  runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    maxAttempts: 3,
    retryDelayMilliseconds: () => 0,
  })
  runtime.register(Holder)
  await runtime.install()
  return runtime
}

async function reminderNames(started: SolidObjectsRuntime): Promise<string[]> {
  const rows = await started.settings.database.connection((connection) =>
    connection.all<{ operation: string }>(
      `SELECT operation FROM ${started.repository.table("reminders")}`,
    ),
  )
  return rows.map((row) => row.operation)
}

describe("a schedule call without an operation", () => {
  it("is a non-retryable error", () => {
    expect(new ScheduleWithoutOperation("message")).toBeInstanceOf(NonRetryableError)
  })

  it("fails the message", async () => {
    const started = await start()

    await expect(started.ref(Holder, "one").holdWithoutOperation()).rejects.toMatchObject({
      details: {
        name: "ScheduleWithoutOperation",
        message: expect.stringMatching(/schedule\(\{ at: .*key: "ada" \}\).*call an operation/is),
      },
    })
  })

  it("commits no state and no reminder, and it does not retry", async () => {
    const started = await start()
    const reference = started.ref(Holder, "one")
    const message = await reference.send.holdWithoutOperation()
    await started.worker().runUntilIdle()

    expect(await message.outcome()).toMatchObject({
      status: "dead",
      error: { name: "ScheduleWithoutOperation" },
      attempts: 1,
    })
    expect((await reference.snapshot()).status).toBe("open")
    expect(await reminderNames(started)).toEqual([])
  })

  it("fails a turn that also has a complete call", async () => {
    const started = await start()

    await expect(started.ref(Holder, "one").holdWithOneOperationMissing()).rejects.toMatchObject({
      details: {
        name: "ScheduleWithoutOperation",
        message: expect.stringMatching(/^(?=.*key: "grace")(?!.*key: "ada")/s),
      },
    })
    expect(await reminderNames(started)).toEqual([])
  })

  it("does not stop a schedule call with an operation", async () => {
    const started = await start()
    const reference = started.ref(Holder, "one")
    await reference.hold()

    expect((await reference.snapshot()).status).toBe("held")
    expect(await reminderNames(started)).toEqual(["expire:ada"])
  })

  it("lets a turn keep the schedule result and call the operation later", async () => {
    const started = await start()
    await started.ref(Holder, "one").holdWithALateOperation()

    expect(await reminderNames(started)).toEqual(["expire:ada"])
  })

  it("does not make the next turn of the same actor fail", async () => {
    const started = await start()
    const reference = started.ref(Holder, "one")
    await expect(reference.holdWithoutOperation()).rejects.toMatchObject({
      details: { name: "ScheduleWithoutOperation" },
    })

    await reference.hold()

    expect(await reminderNames(started)).toEqual(["expire:ada"])
  })
})

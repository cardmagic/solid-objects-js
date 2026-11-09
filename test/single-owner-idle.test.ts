import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { CountingDatabase } from "./support/counting-database.js"

class Counter extends Actor {
  static override readonly actorType = "SingleOwnerIdleCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }
}

let runtime: SolidObjectsRuntime | undefined
let stopRuntime: (() => Promise<void>) | undefined

afterEach(async () => {
  await stopRuntime?.()
  stopRuntime = undefined
  vi.useRealTimers()
  await runtime?.close()
  runtime = undefined
})

function useControlledClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "performance", "Date"],
  })
}

async function startRuntime(options: { singleOwner: boolean }): Promise<CountingDatabase> {
  const database = new CountingDatabase(sqlite({ path: ":memory:" }))
  runtime = createRuntime({
    database,
    singleOwner: options.singleOwner,
    authorizeMessage: () => true,
    broadcast: async () => {},
  })
  runtime.register(Counter)
  await runtime.install()
  const controller = new AbortController()
  const running = runtime.run(controller.signal)
  stopRuntime = async () => {
    controller.abort()
    await running
  }
  return database
}

async function settle(database: CountingDatabase): Promise<void> {
  let observed = -1
  while (observed !== database.statements.length) {
    observed = database.statements.length
    await vi.advanceTimersByTimeAsync(100)
  }
}

describe("an idle singleOwner runtime", () => {
  it("polls without the option, so the measurement can see idle work", async () => {
    useControlledClock()
    const database = await startRuntime({ singleOwner: false })
    await vi.advanceTimersByTimeAsync(5_000)
    const position = database.statements.length

    await vi.advanceTimersByTimeAsync(60_000)

    expect(database.statementsSince(position).length).toBeGreaterThan(100)
  })

  it("sends no statement in 60 seconds", async () => {
    useControlledClock()
    const database = await startRuntime({ singleOwner: true })
    await settle(database)
    const position = database.statements.length

    await vi.advanceTimersByTimeAsync(60_000)

    expect(database.statementsSince(position)).toEqual([])
  })

  it("renews a lease only while it holds the activation, then sends nothing", async () => {
    useControlledClock()
    const database = await startRuntime({ singleOwner: true })
    await settle(database)
    await runtime!.ref(Counter, "one").send.increment()
    await settle(database)
    const activationHeld = database.statements.length

    await vi.advanceTimersByTimeAsync(31_000)

    const whileHeld = database.statementsSince(activationHeld)
    expect(
      whileHeld.filter((statement) =>
        statement.startsWith("UPDATE solid_objects_instances SET activation_expires_at_ms"),
      ).length,
    ).toBeGreaterThanOrEqual(2)
    expect(
      whileHeld.some((statement) =>
        statement.startsWith(
          "UPDATE solid_objects_instances SET activation_owner_id = NULL, activation_token = NULL",
        ),
      ),
    ).toBe(true)
    await settle(database)
    const released = database.statements.length

    await vi.advanceTimersByTimeAsync(60_000)

    expect(database.statementsSince(released)).toEqual([])
  })
})

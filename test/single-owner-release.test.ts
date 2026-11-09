import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { CountingDatabase } from "./support/counting-database.js"
import { deferred } from "./support/fenced-commit.js"

const anHour = 3_600_000
const promptly = 700

class SharedDesk extends Actor {
  static override readonly actorType = "SingleOwnerSharedDesk"
  static entered = deferred()
  static release = deferred()

  visits = 0

  async hold(): Promise<number> {
    SharedDesk.entered.resolve()
    await SharedDesk.release.promise
    this.visits += 1
    return this.visits
  }

  visit(): number {
    this.visits += 1
    return this.visits
  }
}

let runtime: SolidObjectsRuntime | undefined
let stopRuntime: (() => Promise<void>) | undefined

afterEach(async () => {
  SharedDesk.release.resolve()
  await stopRuntime?.()
  stopRuntime = undefined
  await runtime?.close()
  runtime = undefined
  SharedDesk.entered = deferred()
  SharedDesk.release = deferred()
})

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

async function eventually<Value>(options: {
  read: () => Value | Promise<Value>
  until: (value: Value) => boolean
  timeoutMilliseconds: number
}): Promise<Value> {
  const deadline = performance.now() + options.timeoutMilliseconds
  let value = await options.read()
  while (!options.until(value) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    value = await options.read()
  }
  return value
}

describe("an activation release with singleOwner", () => {
  it("wakes the actor workers for a message that waited behind a synchronous caller", async () => {
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      singleOwner: true,
      maxMessagesPerActivationPass: 1,
      pollingIntervalMilliseconds: anHour,
      idlePollingIntervalMilliseconds: anHour,
      authorizeMessage: () => true,
      authorizeQuery: () => true,
    })
    runtime.register(SharedDesk)
    await runtime.install()
    const desk = runtime.ref(SharedDesk, "shared")
    const holding = desk.hold()
    await SharedDesk.entered.promise
    const controller = new AbortController()
    const running = runtime.run(controller.signal)
    stopRuntime = async () => {
      controller.abort()
      await running
    }
    await settled()
    const waiting = await desk.send.visit()
    await settled()

    SharedDesk.release.resolve()
    expect(await holding).toBe(1)

    expect(
      await eventually({
        read: () => waiting.status(),
        until: (status) => status === "completed",
        timeoutMilliseconds: promptly,
      }),
    ).toBe("completed")
  })
})

describe("Repository.releaseActivation", () => {
  it.each([
    { singleOwner: true, readyMessagesWaiting: true, readyQueries: 1 },
    { singleOwner: false, readyMessagesWaiting: false, readyQueries: 0 },
  ])("reports a waiting message only when singleOwner is $singleOwner", async (options) => {
    const database = new CountingDatabase(sqlite({ path: ":memory:" }))
    runtime = createRuntime({ database, singleOwner: options.singleOwner })
    await runtime.install()
    await runtime.repository.registerProcess("holder", "worker")
    for (const operation of ["first", "second"]) {
      await runtime.repository.enqueue({
        actorType: "Probe",
        actorId: "busy",
        operation,
        deliveryMode: "async",
        arguments: {},
      })
    }
    const turn = await runtime.repository.claim("holder")
    await runtime.repository.complete(turn!, {
      state: {},
      stateVersion: 1,
      result: null,
      intents: { effects: [], reminders: [], outboundMessages: [], commitActions: [] },
      executeCommitAction: async () => {},
    })
    const position = database.statements.length

    const released = await runtime.repository.releaseActivation({
      instanceId: turn!.instance.id,
      processId: turn!.processId,
      activationToken: turn!.activationToken,
      activationGeneration: turn!.activationGeneration,
    })

    expect(released).toEqual({ readyMessagesWaiting: options.readyMessagesWaiting })
    expect(
      database
        .statementsSince(position)
        .filter((statement) => statement.includes("FROM solid_objects_ready_messages")),
    ).toHaveLength(options.readyQueries)
  })
})

import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Rejected, Unauthorized } from "../src/errors.js"
import type { SolidObjectsRuntime } from "../src/runtime.js"
import {
  EventSeats,
  HOLD_MILLISECONDS,
  type EventCaller,
} from "../examples/guides/race-conditions/event-seats.js"
import { eventRuntime } from "../examples/guides/race-conditions/event-runtime.js"
import { holdSeatAtomically } from "../examples/guides/race-conditions/atomic-hold.js"
import {
  createLocalMutex,
  holdSeatWithRace,
} from "../examples/guides/race-conditions/lost-update.js"
import { openSeatInventory, seatCounts } from "../examples/guides/race-conditions/seat-inventory.js"

const buyer: EventCaller = { userId: "buyer-1", role: "buyer" }
const organizer: EventCaller = { userId: "organizer-1", role: "organizer" }
const paymentJob: EventCaller = { userId: "payment-job", role: "system" }

let directory: string
const runtimes: SolidObjectsRuntime[] = []
const children: ChildProcess[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "guide-race-"))
})

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(directory, { recursive: true, force: true })
})

async function startRuntime(): Promise<SolidObjectsRuntime> {
  const runtime = eventRuntime({ path: join(directory, "events.sqlite3") })
  runtimes.push(runtime)
  await runtime.install()
  return runtime
}

function startHoldProcess(): ChildProcess {
  const child = fork(fileURLToPath(new URL("./fixtures/event-hold-process.ts", import.meta.url)), {
    execArgv: [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      fileURLToPath(new URL("./support/register-source-hooks.mjs", import.meta.url)),
    ],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })
  children.push(child)
  return child
}

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    child.once("message", resolve)
    child.once("exit", (code) => reject(new Error(`the hold process exited with code ${code}`)))
  })
}

function waitForInput(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

describe("the race without coordination", () => {
  it("lets two async holds take the last seat", async () => {
    const database = openSeatInventory({
      path: join(directory, "seats.sqlite3"),
      eventId: "concert",
      available: 1,
    })

    const results = await Promise.all([
      holdSeatWithRace({ database, eventId: "concert", buyer: "ada", checkBuyer: waitForInput }),
      holdSeatWithRace({ database, eventId: "concert", buyer: "grace", checkBuyer: waitForInput }),
    ])

    expect(results.map((result) => result.held)).toEqual([true, true])
    expect(seatCounts({ database, eventId: "concert" })).toEqual({ available: 0, holds: 2 })
    database.close()
  })

  it("lets a mutex in each process take the last seat twice", async () => {
    const path = join(directory, "seats.sqlite3")
    const firstProcess = {
      database: openSeatInventory({ path, eventId: "concert", available: 1 }),
      mutex: createLocalMutex(),
    }
    const secondProcess = {
      database: openSeatInventory({ path, eventId: "concert", available: 1 }),
      mutex: createLocalMutex(),
    }

    const results = await Promise.all(
      [firstProcess, secondProcess].map(({ database, mutex }, index) =>
        mutex.run(() =>
          holdSeatWithRace({
            database,
            eventId: "concert",
            buyer: `buyer-${index}`,
            checkBuyer: waitForInput,
          }),
        ),
      ),
    )

    expect(results.map((result) => result.held)).toEqual([true, true])
    expect(seatCounts({ database: firstProcess.database, eventId: "concert" }).holds).toBe(2)
    firstProcess.database.close()
    secondProcess.database.close()
  })
})

describe("the native fix", () => {
  it("lets one conditional UPDATE take the last seat once, across connections", async () => {
    const path = join(directory, "seats.sqlite3")
    const connections = [
      openSeatInventory({ path, eventId: "concert", available: 1 }),
      openSeatInventory({ path, eventId: "concert", available: 1 }),
    ]

    const results = connections.map((database, index) =>
      holdSeatAtomically({ database, eventId: "concert", buyer: `buyer-${index}` }),
    )

    expect(results.map((result) => result.held).sort()).toEqual([false, true])
    expect(seatCounts({ database: connections[0]!, eventId: "concert" })).toEqual({
      available: 0,
      holds: 1,
    })
    for (const database of connections) database.close()
  })
})

describe("the EventSeats actor", () => {
  it("keeps the seat count when two processes hold seats at the same time", async () => {
    const path = join(directory, "events.sqlite3")
    const parent = await startRuntime()
    await parent
      .ref(EventSeats, "concert")
      .with({ authorizationContext: organizer })
      .setCapacity({ capacity: 3, expectedRevision: 0 })
    const child = startHoldProcess()
    const childHoldIds = ["child-1", "child-2", "child-3", "child-4"]
    child.send({ path, eventId: "concert", holdIds: childHoldIds })
    await nextMessage(child)

    child.send({ event: "go" })
    const [parentResults, childMessage] = await Promise.all([
      Promise.all(
        ["parent-1", "parent-2", "parent-3", "parent-4"].map((holdId) =>
          parent
            .ref(EventSeats, "concert")
            .with({ authorizationContext: buyer })
            .hold({ holdId, buyer: holdId }),
        ),
      ),
      nextMessage(child),
    ])

    const childResults = (childMessage as { results: { held: boolean }[] }).results
    const held = [...parentResults, ...childResults].filter((result) => result.held)
    expect(held).toHaveLength(3)
    const snapshot = await parent
      .ref(EventSeats, "concert")
      .snapshot({ authorizationContext: buyer })
    expect(Object.keys(snapshot.holds)).toHaveLength(3)
  })

  it("applies a repeated hold once", async () => {
    const runtime = await startRuntime()
    const seats = runtime.ref(EventSeats, "concert")
    await seats
      .with({ authorizationContext: organizer })
      .setCapacity({ capacity: 2, expectedRevision: 0 })

    await seats.with({ authorizationContext: buyer }).hold({ holdId: "hold-1", buyer: "ada" })
    const repeated = await seats
      .with({ authorizationContext: buyer })
      .hold({ holdId: "hold-1", buyer: "ada" })

    expect(repeated).toEqual({ held: true, available: 1 })
  })

  it("expires a hold after a restart, when the reminder is due", async () => {
    const before = await startRuntime()
    await before
      .ref(EventSeats, "concert")
      .with({ authorizationContext: organizer })
      .setCapacity({ capacity: 1, expectedRevision: 0 })
    await before
      .ref(EventSeats, "concert")
      .with({ authorizationContext: buyer })
      .hold({ holdId: "hold-1", buyer: "ada" })
    await before.close()
    runtimes.splice(runtimes.indexOf(before), 1)

    const after = await startRuntime()
    after.register(EventSeats)
    await after.testing.runDueReminders({ now: new Date(Date.now() + HOLD_MILLISECONDS + 1_000) })
    await after.testing.drain({ roles: ["actors"] })

    const snapshot = await after
      .ref(EventSeats, "concert")
      .snapshot({ authorizationContext: buyer })
    expect(snapshot.holds).toEqual({})
    expect(
      await after.ref(EventSeats, "concert").with({ authorizationContext: buyer }).available,
    ).toBe(1)
  })

  it("ignores a late expiry for a hold that the payment job confirmed", async () => {
    const runtime = await startRuntime()
    const seats = runtime.ref(EventSeats, "concert")
    await seats
      .with({ authorizationContext: organizer })
      .setCapacity({ capacity: 1, expectedRevision: 0 })
    await seats.with({ authorizationContext: buyer }).hold({ holdId: "hold-1", buyer: "ada" })
    await seats.with({ authorizationContext: paymentJob }).confirm({ holdId: "hold-1" })

    await seats.with({ authorizationContext: paymentJob }).expire({ holdId: "hold-1" })

    const snapshot = await seats.snapshot({ authorizationContext: buyer })
    expect(snapshot.sold).toEqual({ "hold-1": "ada" })
    expect(snapshot.holds).toEqual({})
    expect(
      await runtime.testing.runDueReminders({
        now: new Date(Date.now() + HOLD_MILLISECONDS + 1_000),
      }),
    ).toBe(0)
  })

  it("rejects a confirmation that arrives after the hold expired", async () => {
    const runtime = await startRuntime()
    const seats = runtime.ref(EventSeats, "concert")
    await seats
      .with({ authorizationContext: organizer })
      .setCapacity({ capacity: 1, expectedRevision: 0 })
    await seats.with({ authorizationContext: buyer }).hold({ holdId: "hold-1", buyer: "ada" })
    await runtime.testing.runDueReminders({ now: new Date(Date.now() + HOLD_MILLISECONDS + 1_000) })
    await runtime.testing.drain({ roles: ["actors"] })

    await expect(
      seats.with({ authorizationContext: paymentJob }).confirm({ holdId: "hold-1" }),
    ).rejects.toMatchObject({
      code: "hold_expired",
    })
  })

  it("rejects a capacity change from a stale form", async () => {
    const runtime = await startRuntime()
    const seats = runtime.ref(EventSeats, "concert").with({ authorizationContext: organizer })
    await seats.setCapacity({ capacity: 10, expectedRevision: 0 })

    await seats.setCapacity({ capacity: 12, expectedRevision: 1 })
    const stale = seats.setCapacity({ capacity: 8, expectedRevision: 1 })

    await expect(stale).rejects.toBeInstanceOf(Rejected)
    await expect(stale).rejects.toMatchObject({ code: "stale_revision" })
    expect(
      (await runtime.ref(EventSeats, "concert").snapshot({ authorizationContext: organizer }))
        .capacity,
    ).toBe(12)
  })

  it("rejects a capacity that is not a whole number of seats", async () => {
    const runtime = await startRuntime()
    const seats = runtime.ref(EventSeats, "concert").with({ authorizationContext: organizer })

    await expect(seats.setCapacity({ capacity: 1.5, expectedRevision: 0 })).rejects.toMatchObject({
      code: "invalid_capacity",
    })
    await expect(seats.setCapacity({ capacity: -1, expectedRevision: 0 })).rejects.toMatchObject({
      code: "invalid_capacity",
    })
  })

  it("lets only an organizer change the capacity", async () => {
    const runtime = await startRuntime()

    await expect(
      runtime
        .ref(EventSeats, "concert")
        .with({ authorizationContext: buyer })
        .setCapacity({ capacity: 5, expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })
})

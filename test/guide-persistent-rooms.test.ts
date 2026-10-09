import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Rejected, Unauthorized } from "../src/errors.js"
import type { SolidObjectsRuntime } from "../src/runtime.js"
import { createMemoryRooms } from "../examples/guides/persistent-rooms/memory-room.js"
import { resumeRoom } from "../examples/guides/persistent-rooms/reconnect.js"
import { roomRuntime } from "../examples/guides/persistent-rooms/room-runtime.js"
import {
  dueTurnDeadlines,
  loadRoom,
  openRoomStore,
  saveRoom,
} from "../examples/guides/persistent-rooms/sql-room.js"
import { TURN_MILLISECONDS, TurnRoom } from "../examples/guides/persistent-rooms/turn-room.js"

let directory: string
const runtimes: SolidObjectsRuntime[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "guide-rooms-"))
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(directory, { recursive: true, force: true })
})

async function startRuntime(): Promise<SolidObjectsRuntime> {
  const runtime = roomRuntime({ path: join(directory, "rooms.sqlite3") })
  runtimes.push(runtime)
  await runtime.install()
  return runtime
}

async function stopRuntime(runtime: SolidObjectsRuntime): Promise<void> {
  await runtime.close()
  runtimes.splice(runtimes.indexOf(runtime), 1)
}

function asPlayer(playerId: string): { authorizationContext: { playerId: string } } {
  return { authorizationContext: { playerId } }
}

async function startedRoom(runtime: SolidObjectsRuntime): Promise<void> {
  const room = runtime.ref(TurnRoom, "table-1")
  await room.with(asPlayer("ada")).join({ playerId: "ada" })
  await room.with(asPlayer("grace")).join({ playerId: "grace" })
  await room.with(asPlayer("ada")).start({ playerId: "ada" })
}

describe("a room in process memory", () => {
  it("loses the room and its turn timer when the process restarts", () => {
    const beforeRestart = createMemoryRooms({ turnMilliseconds: TURN_MILLISECONDS })
    beforeRestart.join({ roomId: "table-1", playerId: "ada" })
    beforeRestart.join({ roomId: "table-1", playerId: "grace" })
    beforeRestart.start({ roomId: "table-1" })
    expect(beforeRestart.pendingTimers()).toBe(1)
    beforeRestart.close()

    const afterRestart = createMemoryRooms({ turnMilliseconds: TURN_MILLISECONDS })

    expect(afterRestart.room({ roomId: "table-1" })).toBeUndefined()
    expect(afterRestart.pendingTimers()).toBe(0)
    afterRestart.close()
  })
})

describe("the native fix with a version column", () => {
  it("keeps the room after a restart and rejects a write from an old version", () => {
    const path = join(directory, "store.sqlite3")
    const beforeRestart = openRoomStore({ path })
    saveRoom({
      database: beforeRestart,
      roomId: "table-1",
      state: { players: ["ada"], turnNumber: 0 },
      expectedVersion: 0,
      turnDeadline: 1_000,
    })
    beforeRestart.close()

    const afterRestart = openRoomStore({ path })
    const loaded = loadRoom({ database: afterRestart, roomId: "table-1" })
    expect(loaded).toEqual({ state: { players: ["ada"], turnNumber: 0 }, version: 1 })

    expect(
      saveRoom({
        database: afterRestart,
        roomId: "table-1",
        state: { players: ["ada"], turnNumber: 1 },
        expectedVersion: 1,
        turnDeadline: 2_000,
      }),
    ).toEqual({ saved: true })
    expect(
      saveRoom({
        database: afterRestart,
        roomId: "table-1",
        state: { players: ["ada"], turnNumber: 9 },
        expectedVersion: 1,
        turnDeadline: 3_000,
      }),
    ).toEqual({ saved: false })
    expect(dueTurnDeadlines({ database: afterRestart, now: 2_000 })).toEqual(["table-1"])
    afterRestart.close()
  })
})

describe("a stored room with an unexpected shape", () => {
  it("fails to load instead of returning unchecked state", () => {
    const database = openRoomStore({ path: join(directory, "store.sqlite3") })
    database
      .prepare("INSERT INTO rooms (room_id, state, version, turn_deadline) VALUES (?, ?, 1, NULL)")
      .run("table-9", JSON.stringify({ players: "ada" }))

    expect(() => loadRoom({ database, roomId: "table-9" })).toThrow("unexpected shape")
    database.close()
  })
})

describe("the TurnRoom actor", () => {
  it("applies one of two submissions for the same turn", async () => {
    const runtime = await startRuntime()
    await startedRoom(runtime)
    const room = runtime.ref(TurnRoom, "table-1").with(asPlayer("ada"))

    const outcomes = await Promise.allSettled([
      room.play({ playerId: "ada", move: "e4", turnNumber: 0 }),
      room.play({ playerId: "ada", move: "d4", turnNumber: 0 }),
    ])

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"])
    const rejected = outcomes.find((outcome) => outcome.status === "rejected")
    expect(rejected?.reason).toBeInstanceOf(Rejected)
    expect((rejected?.reason as Rejected).code).toBe("stale_turn")
    const snapshot = await runtime.ref(TurnRoom, "table-1").snapshot(asPlayer("ada"))
    expect(snapshot.moves).toHaveLength(1)
    expect(snapshot.turnNumber).toBe(1)
  })

  it("rejects a move from the player who does not have the turn", async () => {
    const runtime = await startRuntime()
    await startedRoom(runtime)

    await expect(
      runtime
        .ref(TurnRoom, "table-1")
        .with(asPlayer("grace"))
        .play({ playerId: "grace", move: "e5", turnNumber: 0 }),
    ).rejects.toMatchObject({ code: "not_your_turn" })
  })

  it("rejects a move for another player", async () => {
    const runtime = await startRuntime()
    await startedRoom(runtime)

    await expect(
      runtime
        .ref(TurnRoom, "table-1")
        .with(asPlayer("grace"))
        .play({ playerId: "ada", move: "e4", turnNumber: 0 }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })

  it("skips the turn after a restart when the turn timer is due", async () => {
    const beforeRestart = await startRuntime()
    await startedRoom(beforeRestart)
    await stopRuntime(beforeRestart)

    const afterRestart = await startRuntime()
    await afterRestart.testing.runDueReminders({
      now: new Date(Date.now() + TURN_MILLISECONDS + 1_000),
    })
    await afterRestart.testing.drain({ roles: ["actors"] })

    const snapshot = await afterRestart.ref(TurnRoom, "table-1").snapshot(asPlayer("grace"))
    expect(snapshot.skippedTurns).toEqual([0])
    expect(snapshot.turnNumber).toBe(1)
    expect(await afterRestart.ref(TurnRoom, "table-1").with(asPlayer("grace")).currentPlayer).toBe(
      "grace",
    )
  })

  it("ignores a turn timer for a turn that already ended", async () => {
    const runtime = await startRuntime()
    await startedRoom(runtime)
    await runtime
      .ref(TurnRoom, "table-1")
      .with(asPlayer("ada"))
      .play({ playerId: "ada", move: "e4", turnNumber: 0 })

    await runtime.testing.runDueReminders({ now: new Date(Date.now() + TURN_MILLISECONDS / 2) })
    await runtime.testing.drain({ roles: ["actors"] })

    const snapshot = await runtime.ref(TurnRoom, "table-1").snapshot(asPlayer("ada"))
    expect(snapshot.skippedTurns).toEqual([])
    expect(snapshot.turnNumber).toBe(1)
  })

  it("lets no caller run the turn timer directly", async () => {
    const runtime = await startRuntime()
    await startedRoom(runtime)

    await expect(
      runtime.ref(TurnRoom, "table-1").with(asPlayer("ada")).turnTimeout({ turnNumber: 0 }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })
})

describe("reconnect", () => {
  it("returns the current room to a member after a restart", async () => {
    const beforeRestart = await startRuntime()
    await startedRoom(beforeRestart)
    const lastSeen = (await beforeRestart.ref(TurnRoom, "table-1").snapshot(asPlayer("grace")))
      .revision
    await beforeRestart
      .ref(TurnRoom, "table-1")
      .with(asPlayer("ada"))
      .play({ playerId: "ada", move: "e4", turnNumber: 0 })
    await stopRuntime(beforeRestart)

    const afterRestart = await startRuntime()
    const resumed = await resumeRoom({
      runtime: afterRestart,
      roomId: "table-1",
      playerId: "grace",
      lastSeenRevision: lastSeen,
    })

    expect(resumed).toMatchObject({
      changed: true,
      room: { turnNumber: 1, moves: [{ playerId: "ada", move: "e4" }] },
    })
  })

  it("returns nothing to a player who is not in the room", async () => {
    const runtime = await startRuntime()
    await startedRoom(runtime)

    expect(
      await resumeRoom({ runtime, roomId: "table-1", playerId: "mallory", lastSeenRevision: 0 }),
    ).toBeNull()
  })
})

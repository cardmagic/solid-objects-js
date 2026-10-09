# Keep turn-based room state through restarts in Node.js

A room in process memory loses its state and its turn timer when the process restarts. Store the room in SQL. Arm the turn timer from durable data. One actor per room gives you ordered moves, a durable turn timer, and the current state after a restart. This guide uses `solid-objects` for turn-based games, lobbies, and shared boards in Node.js.

## The failure: state and timers in process memory

```typescript
type MemoryRoom = { players: string[]; turnNumber: number; started: boolean }

export function createMemoryRooms({ turnMilliseconds }: { turnMilliseconds: number }) {
  const rooms = new Map<string, MemoryRoom>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function armTurnTimer(roomId: string): void {
    clearTimeout(timers.get(roomId))
    timers.set(
      roomId,
      setTimeout(() => skipTurn(roomId), turnMilliseconds),
    )
  }

  function skipTurn(roomId: string): void {
    const room = rooms.get(roomId)
    if (!room) return
    rooms.set(roomId, { ...room, turnNumber: room.turnNumber + 1 })
    armTurnTimer(roomId)
  }

  return {
    join({ roomId, playerId }: { roomId: string; playerId: string }): void {
      const room = rooms.get(roomId) ?? { players: [], turnNumber: 0, started: false }
      rooms.set(roomId, { ...room, players: [...room.players, playerId] })
    },
    start({ roomId }: { roomId: string }): void {
      const room = rooms.get(roomId)
      if (!room) return
      rooms.set(roomId, { ...room, started: true })
      armTurnTimer(roomId)
    },
    room({ roomId }: { roomId: string }): MemoryRoom | undefined {
      return rooms.get(roomId)
    },
    pendingTimers(): number {
      return timers.size
    },
    close(): void {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
```

The `Map` holds the room state in one process. The `setTimeout` holds the turn timer in that process. Neither survives a process restart. A deploy or a crash loses both. A second process has its own memory and cannot read the first process's room or timer.

The test models a restart with two instances of `createMemoryRooms`. It starts a game with two players and checks that one timer exists. It then calls `close` and creates a new instance. The new instance has no room and no timer. The test uses new instances in the same process.

## The native fix: a row with a version and a deadline

```typescript
import { DatabaseSync } from "node:sqlite"

export type RoomState = { players: string[]; turnNumber: number }

export function openRoomStore({ path }: { path: string }): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      turn_deadline INTEGER
    )
  `)
  return database
}

export function saveRoom({
  database,
  roomId,
  state,
  expectedVersion,
  turnDeadline,
}: {
  database: DatabaseSync
  roomId: string
  state: RoomState
  expectedVersion: number
  turnDeadline: number | null
}): { saved: boolean } {
  if (expectedVersion === 0) {
    const inserted = database
      .prepare(
        "INSERT OR IGNORE INTO rooms (room_id, state, version, turn_deadline) VALUES (?, ?, 1, ?)",
      )
      .run(roomId, JSON.stringify(state), turnDeadline)
    return { saved: inserted.changes === 1 }
  }
  const updated = database
    .prepare(
      "UPDATE rooms SET state = ?, version = version + 1, turn_deadline = ? WHERE room_id = ? AND version = ?",
    )
    .run(JSON.stringify(state), turnDeadline, roomId, expectedVersion)
  return { saved: updated.changes === 1 }
}

export function loadRoom({
  database,
  roomId,
}: {
  database: DatabaseSync
  roomId: string
}): { state: RoomState; version: number } | undefined {
  const row = database.prepare("SELECT state, version FROM rooms WHERE room_id = ?").get(roomId) as
    { state: string; version: number } | undefined
  if (!row) return undefined
  const state: unknown = JSON.parse(row.state)
  if (!isRoomState(state)) throw new Error(`stored room ${roomId} has an unexpected shape`)
  return { state, version: row.version }
}

export function dueTurnDeadlines({
  database,
  now,
}: {
  database: DatabaseSync
  now: number
}): string[] {
  const rows = database
    .prepare("SELECT room_id FROM rooms WHERE turn_deadline <= ? ORDER BY turn_deadline")
    .all(now) as { room_id: string }[]
  return rows.map((row) => row.room_id)
}

function isRoomState(value: unknown): value is RoomState {
  if (typeof value !== "object" || value === null) return false
  if (!("players" in value) || !Array.isArray(value.players)) return false
  if (!value.players.every((player) => typeof player === "string")) return false
  return "turnNumber" in value && Number.isSafeInteger(value.turnNumber)
}
```

The SQL design stores each room as JSON in a row with a `version` column and a turn deadline. `loadRoom` returns the state and its version. It checks the stored JSON against `RoomState` and throws when the shape is unexpected, so the caller never uses unchecked data. The caller passes that version to `saveRoom` as `expectedVersion`.

`saveRoom` updates a row only when its version still matches. A successful update also increases the version. A write from an old version returns `{ saved: false }`. The caller then reloads the room and tries again. An old copy of the state cannot replace a newer copy.

The row also stores `turn_deadline`. Call `dueTurnDeadlines` at startup and on an interval. It finds rooms whose deadline equals or precedes `now`. The deadline survives because SQL stores it with the state. The query finds due rooms; it does not apply their timeouts.

The application still owns these parts:

- A retry loop for version conflicts.
- A sweep process that checks deadlines.
- A rule that permits only one process to apply each timeout.

The test closes the database and opens the same database again. The room survives. A write with the current version succeeds, and a write with the old version fails. The sweep then finds the due room.

## One actor per room

```typescript
import { Actor } from "solid-objects"

export const TURN_MILLISECONDS = 60_000

const MAXIMUM_PLAYERS = 4

type Move = { playerId: string; move: string; turnNumber: number }

export class TurnRoom extends Actor {
  static override readonly actorType = "TurnRoom"

  players: string[] = []
  started = false
  turnNumber = 0
  moves: Move[] = []
  skippedTurns: number[] = []
  revision = 0

  get currentPlayer(): string | null {
    if (!this.started) return null
    return this.players[this.turnNumber % this.players.length] ?? null
  }

  join({ playerId }: { playerId: string }): { players: string[] } {
    if (this.players.includes(playerId)) return { players: this.players }
    if (this.started) this.reject("game_started", { message: "The game already started" })
    if (this.players.length === MAXIMUM_PLAYERS) {
      this.reject("room_full", { message: "The room is full" })
    }
    this.players = [...this.players, playerId]
    this.revision += 1
    return { players: this.players }
  }

  start({ playerId }: { playerId: string }): { turnNumber: number } {
    if (this.started) return { turnNumber: this.turnNumber }
    if (!this.players.includes(playerId)) {
      this.reject("not_in_room", { message: "Only a player in the room can start the game" })
    }
    if (this.players.length < 2) {
      this.reject("not_enough_players", { message: "The game needs two players" })
    }
    this.started = true
    this.revision += 1
    this.#armTurnTimer()
    return { turnNumber: this.turnNumber }
  }

  play({ playerId, move, turnNumber }: { playerId: string; move: string; turnNumber: number }): {
    turnNumber: number
  } {
    if (!this.started) this.reject("game_not_started", { message: "The game has not started" })
    if (turnNumber !== this.turnNumber) {
      this.reject("stale_turn", {
        message: "That turn already ended",
        details: { turnNumber: this.turnNumber },
      })
    }
    if (playerId !== this.currentPlayer) {
      this.reject("not_your_turn", { message: "It is not your turn" })
    }
    this.moves = [...this.moves, { playerId, move, turnNumber }]
    this.#advanceTurn()
    return { turnNumber: this.turnNumber }
  }

  turnTimeout({ turnNumber }: { turnNumber: number }): { skipped: boolean } {
    if (turnNumber !== this.turnNumber) return { skipped: false }
    this.skippedTurns = [...this.skippedTurns, turnNumber]
    this.#advanceTurn()
    return { skipped: true }
  }

  #advanceTurn(): void {
    this.turnNumber += 1
    this.revision += 1
    this.#armTurnTimer()
  }

  #armTurnTimer(): void {
    this.schedule({ at: new Date(Date.now() + TURN_MILLISECONDS) }).turnTimeout({
      turnNumber: this.turnNumber,
    })
  }
}
```

Each room has one `TurnRoom` actor identity. Moves for that room run one at a time, in order, across processes. The actor stores the players, moves, turn number, skipped turns, and revision. Other rooms have separate identities.

`play` takes the `turnNumber` that the client saw. The actor compares that value with its current turn number before it accepts the move. Two tabs can submit different moves for the same turn. The first accepted move advances the turn. The second submission then rejects with `stale_turn`.

The actor also checks the player. A move from the wrong player rejects with `not_your_turn`. The getter `currentPlayer` identifies the player for the current turn. Before the game starts, it returns `null`. A getter is a read-only query.

Each turn arms `schedule({ at }).turnTimeout({ turnNumber })`. The reminder stores the turn number that it applies to. A reminder with the same operation and no key moves the same alarm. It does not add a second alarm. Thus, a move sets a new deadline for the next turn.

`turnTimeout` compares its argument with the current turn number. It does nothing when that turn already ended. A late or repeated timer cannot skip a later turn. A valid timeout records the skipped turn and advances to the next turn.

`revision` increases on every change to the room. A client compares revisions to detect missed changes. A repeated `join` for the same player returns the players without a change. It does not increase `revision`.

## Authorize players

```typescript
import { createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { TurnRoom } from "./turn-room.js"

export type RoomCaller = { playerId: string }

const PLAYER_OPERATIONS = new Set(["join", "start", "play"])

export function authorizeRoomMessage({
  actorType,
  operation,
  arguments: argumentsValue,
  authorizationContext,
}: {
  actorType: string
  operation: string
  arguments: Record<string, unknown>
  authorizationContext: unknown
}): boolean {
  if (actorType !== TurnRoom.actorType) return false
  if (!PLAYER_OPERATIONS.has(operation)) return false
  if (!isRoomCaller(authorizationContext)) return false
  return argumentsValue.playerId === authorizationContext.playerId
}

export function authorizeRoomQuery({
  actorType,
  authorizationContext,
}: {
  actorType: string
  authorizationContext: unknown
}): boolean {
  return actorType === TurnRoom.actorType && isRoomCaller(authorizationContext)
}

export function roomRuntime({ path }: { path: string }): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path }),
    authorizeMessage: authorizeRoomMessage,
    authorizeQuery: authorizeRoomQuery,
  })
  runtime.register(TurnRoom)
  return runtime
}

function isRoomCaller(value: unknown): value is RoomCaller {
  if (typeof value !== "object" || value === null) return false
  return "playerId" in value && typeof value.playerId === "string"
}
```

All authorization callbacks deny by default. The application supplies a policy for messages and queries. The message policy permits only `join`, `start`, and `play` for `TurnRoom`.

The policy binds the `playerId` argument to the authenticated player in `authorizationContext`. One player cannot submit a move for another player. The application authenticates the WebSocket or HTTP request and passes the player as `authorizationContext`. A player identifier from an untrusted request does not establish that identity.

No caller can run `turnTimeout` directly through this policy. Only the runtime runs it from the reminder. The query policy checks the actor type and the player context. The reconnect function below also checks room membership before it returns the room.

## Reconnect: send the current room

```typescript
import type { ActorSnapshot, SolidObjectsRuntime } from "solid-objects"
import { TurnRoom } from "./turn-room.js"

export async function resumeRoom({
  runtime,
  roomId,
  playerId,
  lastSeenRevision,
}: {
  runtime: SolidObjectsRuntime
  roomId: string
  playerId: string
  lastSeenRevision: number
}): Promise<{ room: ActorSnapshot<TurnRoom>; changed: boolean } | null> {
  const room = await runtime.ref(TurnRoom, roomId).snapshot({ authorizationContext: { playerId } })
  if (!room.players.includes(playerId)) return null
  return { room, changed: room.revision !== lastSeenRevision }
}
```

After a reconnect or a server restart, the server reads the room with the player's authorization and sends it. `resumeRoom` reads a snapshot with `authorizationContext`. It returns `null` to a player who is not in the room. Keep this membership check on the path that sends room state to the client.

For a room member, `resumeRoom` returns the room and `changed`. It compares `revision` with `lastSeenRevision` to calculate `changed`. The client compares the current revision with the last revision it saw. A difference shows that the client missed a change.

Socket.IO connection state recovery restores the socket id, rooms, and `data` when recovery succeeds. The server must enable this feature. It also sends events that the client missed during a temporary disconnection. The documentation says recovery “will not always be successful”, so the application must still synchronize client and server state. [Socket.IO documentation](https://socket.io/docs/v4/connection-state-recovery).

Adapter support also matters:

- The in-memory adapter supports recovery.
- The Redis adapter does not support recovery.
- The Redis Streams adapter supports recovery.
- The MongoDB adapter supports recovery.

The [Socket.IO adapter table](https://socket.io/docs/v4/connection-state-recovery#compatibility-with-existing-adapters) lists this support. Socket.IO recovery and this pattern work together. Socket.IO restores the connection, and the actor restores the authorized room state.

## Run the runtime process

The turn timer is a reminder. In normal operation, reminders run only while a process calls `runtime.run(signal)`. The `roomRuntime` function registers `TurnRoom` before the runtime starts. The process must know the actor class to execute its operations.

Run the background roles as described in [step 7 of the agent guide](../agents.md#7-run-the-background-roles). When no process runs, the due reminder waits in SQL. It runs when a process starts. The runtime needs a process to execute each timeout.

In tests, `runtime.testing.runDueReminders({ now })` finds due reminders at the supplied time. Then `runtime.testing.drain({ roles: ["actors"] })` runs the actor work. These calls test due timers without a wait for the real deadline.

## What the tests prove

The [tests for persistent rooms](../../test/guide-persistent-rooms.test.ts) check these cases in this order:

1. A new instance of the memory design has no room and no timer after a simulated restart.
2. The SQL room survives a database reopen. A write from an old version fails, and the sweep finds the due room. A stored room with an unexpected shape fails to load.
3. Two submissions for one turn produce one accepted move and one `stale_turn` rejection.
4. A move from the wrong player rejects with `not_your_turn`.
5. A caller cannot submit a move for another player.
6. After a runtime restart, a due reminder skips turn zero and makes the second player current.
7. After a move, a sweep before the next deadline leaves the turn unchanged and records no skipped turn.
8. A caller cannot invoke `turnTimeout` directly.
9. After a restart, a room member receives the current room, its move, and `changed: true`.
10. A player outside the room receives `null` from `resumeRoom`.

The seventh test does not inject a late or repeated timer. The turn number check in `turnTimeout` handles that case.

## Limits

Delivery is at least once. Write each operation so that it can run again. One room runs one write at a time. This fits turn-based play, not a high-frequency game loop or fast real-time physics.

The application owns the WebSocket server, authentication, and the display of the room. There are no transactions across two rooms. The package requires Node.js 24.4 or newer and ESM only. The package is pre-1.0.

See [Correctness and delivery semantics](../correctness.md) and [Virtual actors in TypeScript and Node.js](../virtual-actors.md).

## Sources

Socket.IO, [Connection state recovery](https://socket.io/docs/v4/connection-state-recovery), checked October 9, 2026.

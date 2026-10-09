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

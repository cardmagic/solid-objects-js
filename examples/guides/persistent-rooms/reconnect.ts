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

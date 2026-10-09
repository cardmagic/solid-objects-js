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

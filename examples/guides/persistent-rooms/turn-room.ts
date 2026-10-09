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

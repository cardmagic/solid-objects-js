import { Actor } from "solid-objects"

export const HOLD_MILLISECONDS = 10 * 60 * 1000

export type EventCaller = { userId: string; role: "buyer" | "organizer" | "system" }

type Hold = { buyer: string; expiresAt: number }

export class EventSeats extends Actor {
  static override readonly actorType = "EventSeats"

  capacity = 0
  revision = 0
  holds: Record<string, Hold> = {}
  sold: Record<string, string> = {}

  get available(): number {
    return this.capacity - Object.keys(this.holds).length - Object.keys(this.sold).length
  }

  setCapacity({ capacity, expectedRevision }: { capacity: number; expectedRevision: number }): {
    revision: number
  } {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      this.reject("invalid_capacity", { message: "Capacity must be a whole number of seats" })
    }
    if (expectedRevision !== this.revision) {
      this.reject("stale_revision", {
        message: "The event changed after you loaded it",
        details: { revision: this.revision },
      })
    }
    if (capacity < this.capacity - this.available) {
      this.reject("capacity_below_sold", { message: "Holds and sales already use more seats" })
    }
    this.capacity = capacity
    this.revision += 1
    return { revision: this.revision }
  }

  hold({ holdId, buyer }: { holdId: string; buyer: string }): { held: boolean; available: number } {
    if (Object.hasOwn(this.holds, holdId) || Object.hasOwn(this.sold, holdId)) {
      return { held: true, available: this.available }
    }
    if (this.available <= 0) return { held: false, available: 0 }

    const expiresAt = Date.now() + HOLD_MILLISECONDS
    this.holds = { ...this.holds, [holdId]: { buyer, expiresAt } }
    this.schedule({ at: new Date(expiresAt), key: holdId }).expire({ holdId })
    return { held: true, available: this.available }
  }

  confirm({ holdId }: { holdId: string }): { confirmed: boolean } {
    if (Object.hasOwn(this.sold, holdId)) return { confirmed: true }
    const hold = this.holds[holdId]
    if (!hold) {
      this.reject("hold_expired", { message: "The hold expired before the payment arrived" })
    }

    this.holds = withoutKey(this.holds, holdId)
    this.sold = { ...this.sold, [holdId]: hold.buyer }
    this.unschedule("expire", { key: holdId })
    return { confirmed: true }
  }

  expire({ holdId }: { holdId: string }): { expired: boolean } {
    if (!Object.hasOwn(this.holds, holdId)) return { expired: false }

    this.holds = withoutKey(this.holds, holdId)
    return { expired: true }
  }
}

function withoutKey<Value>(record: Record<string, Value>, key: string): Record<string, Value> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))
}

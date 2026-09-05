import { Actor, broadcastValue } from "solid-objects/core"

export class Counter extends Actor {
  static override readonly actorType = "Counter"
  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }

  incrementLater(): void {
    this.schedule({ at: new Date(Date.now() + 5_000) }).increment!()
  }

  override observables() {
    return { count: broadcastValue(this.count) }
  }
}

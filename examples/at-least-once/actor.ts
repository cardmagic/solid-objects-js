import { Actor } from "solid-objects"

export class DeliveryCounter extends Actor {
  static override readonly actorType = "DeliveryCounter"

  count = 0

  deliver(): number {
    this.count += 1
    this.emit("record", { arguments: {} })
    return this.count
  }
}

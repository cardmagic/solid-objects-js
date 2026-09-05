import { Actor } from "../../src/core.js"

export class PortableCounter extends Actor {
  static override readonly actorType = "PortableCounter"
  count = 0

  increment(options: { amount?: number } = {}): number {
    this.count += options.amount ?? 1
    return this.count
  }

  get doubled(): number {
    return this.count * 2
  }

  async incrementAfterAwait(): Promise<number> {
    const previous = this.count
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    this.count = previous + 1
    return this.count
  }

  rejectChange(): void {
    this.count = 100
    this.reject("unavailable", { message: "try again later" })
  }
}

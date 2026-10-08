import { Actor, configure } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

const HOLD_MILLISECONDS = 10 * 60 * 1000

export class TicketSale extends Actor {
  static override readonly actorType = "TicketSale"

  available = 1
  holds: Record<string, number> = {}

  hold({ buyer }: { buyer: string }): { held: boolean; available: number } {
    if (this.available === 0 || buyer in this.holds) {
      return { held: false, available: this.available }
    }

    this.available -= 1
    this.holds = { ...this.holds, [buyer]: Date.now() }
    this.schedule({ at: new Date(Date.now() + HOLD_MILLISECONDS), key: buyer }).expire({ buyer })
    return { held: true, available: this.available }
  }

  expire({ buyer }: { buyer: string }): number {
    if (!(buyer in this.holds)) return this.available

    const remainingHolds = { ...this.holds }
    delete remainingHolds[buyer]
    this.holds = remainingHolds
    this.available += 1
    return this.available
  }
}

const runtime = configure({
  database: sqlite({ path: process.env.TICKET_DATABASE ?? "tickets.sqlite3" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
})

await runtime.install()

try {
  const sale = TicketSale.ref("event-42")

  if (process.argv[2] === "work") {
    const controller = new AbortController()
    process.once("SIGINT", () => controller.abort())
    process.once("SIGTERM", () => controller.abort())
    await runtime.run(controller.signal)
  } else {
    const results = await Promise.all(["ada", "grace"].map((buyer) => sale.hold({ buyer })))
    console.log(JSON.stringify(results))
  }
} finally {
  await runtime.close()
}

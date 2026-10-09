import type { DatabaseSync } from "node:sqlite"

export async function holdSeatWithRace({
  database,
  eventId,
  buyer,
  checkBuyer,
}: {
  database: DatabaseSync
  eventId: string
  buyer: string
  checkBuyer: () => Promise<void>
}): Promise<{ held: boolean }> {
  const row = database.prepare("SELECT available FROM seats WHERE event_id = ?").get(eventId) as {
    available: number
  }
  if (row.available === 0) return { held: false }

  await checkBuyer()

  database
    .prepare("UPDATE seats SET available = ? WHERE event_id = ?")
    .run(row.available - 1, eventId)
  database.prepare("INSERT INTO holds (event_id, buyer) VALUES (?, ?)").run(eventId, buyer)
  return { held: true }
}

export function createLocalMutex(): { run<Result>(task: () => Promise<Result>): Promise<Result> } {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<Result>(task: () => Promise<Result>): Promise<Result> {
      const result = tail.then(task)
      tail = result.catch(() => undefined)
      return result
    },
  }
}

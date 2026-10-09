import type { DatabaseSync } from "node:sqlite"

export function holdSeatAtomically({
  database,
  eventId,
  buyer,
}: {
  database: DatabaseSync
  eventId: string
  buyer: string
}): { held: boolean } {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = database
      .prepare("UPDATE seats SET available = available - 1 WHERE event_id = ? AND available > 0")
      .run(eventId)
    if (result.changes === 0) {
      database.exec("ROLLBACK")
      return { held: false }
    }
    database.prepare("INSERT INTO holds (event_id, buyer) VALUES (?, ?)").run(eventId, buyer)
    database.exec("COMMIT")
    return { held: true }
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

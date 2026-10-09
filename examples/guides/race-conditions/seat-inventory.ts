import { DatabaseSync } from "node:sqlite"

export function openSeatInventory({
  path,
  eventId,
  available,
}: {
  path: string
  eventId: string
  available: number
}): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE IF NOT EXISTS seats (event_id TEXT PRIMARY KEY, available INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS holds (event_id TEXT NOT NULL, buyer TEXT NOT NULL);
  `)
  database
    .prepare("INSERT OR IGNORE INTO seats (event_id, available) VALUES (?, ?)")
    .run(eventId, available)
  return database
}

export function seatCounts({ database, eventId }: { database: DatabaseSync; eventId: string }): {
  available: number
  holds: number
} {
  const seats = database.prepare("SELECT available FROM seats WHERE event_id = ?").get(eventId) as {
    available: number
  }
  const holds = database
    .prepare("SELECT COUNT(*) AS count FROM holds WHERE event_id = ?")
    .get(eventId) as {
    count: number
  }
  return { available: seats.available, holds: holds.count }
}

import { DatabaseSync } from "node:sqlite"

export function openRoomStore({ path }: { path: string }): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      turn_deadline INTEGER
    )
  `)
  return database
}

export function saveRoom({
  database,
  roomId,
  state,
  expectedVersion,
  turnDeadline,
}: {
  database: DatabaseSync
  roomId: string
  state: unknown
  expectedVersion: number
  turnDeadline: number | null
}): { saved: boolean } {
  if (expectedVersion === 0) {
    const inserted = database
      .prepare(
        "INSERT OR IGNORE INTO rooms (room_id, state, version, turn_deadline) VALUES (?, ?, 1, ?)",
      )
      .run(roomId, JSON.stringify(state), turnDeadline)
    return { saved: inserted.changes === 1 }
  }
  const updated = database
    .prepare(
      "UPDATE rooms SET state = ?, version = version + 1, turn_deadline = ? WHERE room_id = ? AND version = ?",
    )
    .run(JSON.stringify(state), turnDeadline, roomId, expectedVersion)
  return { saved: updated.changes === 1 }
}

export function loadRoom({
  database,
  roomId,
}: {
  database: DatabaseSync
  roomId: string
}): { state: unknown; version: number } | undefined {
  const row = database.prepare("SELECT state, version FROM rooms WHERE room_id = ?").get(roomId) as
    { state: string; version: number } | undefined
  if (!row) return undefined
  return { state: JSON.parse(row.state), version: row.version }
}

export function dueTurnDeadlines({
  database,
  now,
}: {
  database: DatabaseSync
  now: number
}): string[] {
  const rows = database
    .prepare("SELECT room_id FROM rooms WHERE turn_deadline <= ? ORDER BY turn_deadline")
    .all(now) as { room_id: string }[]
  return rows.map((row) => row.room_id)
}

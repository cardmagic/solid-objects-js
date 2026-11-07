import assert from "node:assert/strict"
import type { Database } from "../src/database/types.js"

export async function benchmarkDurability(
  database: Database,
): Promise<Record<string, string | number>> {
  return database.connection(async (connection) => {
    if (database.family === "sqlite") {
      const journalMode = await connection.get<{ journal_mode: string }>("PRAGMA journal_mode")
      const synchronous = await connection.get<{ synchronous: number | bigint }>(
        "PRAGMA synchronous",
      )
      assert.ok(journalMode && synchronous)
      return { journalMode: journalMode.journal_mode, synchronous: Number(synchronous.synchronous) }
    }
    if (database.family === "postgresql") {
      const settings = await connection.get<{ fsync: string; synchronous_commit: string }>(
        "SELECT current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit",
      )
      assert.ok(settings)
      return { fsync: settings.fsync, synchronousCommit: settings.synchronous_commit }
    }
    const settings = await connection.get<{
      innodb_flush_log_at_trx_commit: number | bigint
      sync_binlog: number | bigint
    }>(
      "SELECT @@innodb_flush_log_at_trx_commit AS innodb_flush_log_at_trx_commit, @@sync_binlog AS sync_binlog",
    )
    assert.ok(settings)
    return {
      innodbFlushLogAtTrxCommit: Number(settings.innodb_flush_log_at_trx_commit),
      syncBinlog: Number(settings.sync_binlog),
    }
  })
}

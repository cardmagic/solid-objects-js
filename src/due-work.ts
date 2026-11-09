import type { RuntimeSettings } from "./configuration.js"

interface DueRow {
  due_at_ms: number | bigint | null
}

export class DueWork {
  constructor(private readonly settings: RuntimeSettings) {}

  untilActorWork(options: { processId: string }): Promise<number | undefined> {
    return this.untilDue(() => ({
      sql: `SELECT MIN(due_at_ms) AS due_at_ms FROM (
        SELECT CASE
            WHEN instances.activation_owner_id IS NOT NULL
              AND instances.activation_owner_id <> ?
              AND instances.activation_expires_at_ms > ready.available_at_ms
            THEN instances.activation_expires_at_ms
            ELSE ready.available_at_ms
          END AS due_at_ms
        FROM ${this.table("ready_messages")} ready
        JOIN ${this.table("instances")} instances ON instances.id = ready.instance_id
        WHERE instances.paused = 0
          AND NOT EXISTS (
            SELECT 1 FROM ${this.table("ready_messages")} earlier
            WHERE earlier.instance_id = ready.instance_id AND earlier.sequence < ready.sequence
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${this.table("claimed_messages")} claimed
            WHERE claimed.instance_id = ready.instance_id AND claimed.sequence < ready.sequence
          )
        UNION ALL
        SELECT instances.activation_expires_at_ms AS due_at_ms
        FROM ${this.table("claimed_messages")} claimed
        JOIN ${this.table("instances")} instances ON instances.id = claimed.instance_id
        WHERE instances.activation_expires_at_ms IS NOT NULL
      ) due`,
      parameters: [options.processId],
    }))
  }

  untilEffectWork(): Promise<number | undefined> {
    const threshold = this.settings.processAliveThresholdMilliseconds
    return this.untilDue((now) => ({
      sql: `SELECT MIN(due_at_ms) AS due_at_ms FROM (
        SELECT effects.available_at_ms AS due_at_ms
        FROM ${this.table("effects")} effects
        WHERE effects.status = 'pending'
        UNION ALL
        SELECT CASE
            WHEN owners.id IS NULL THEN ?
            WHEN recoveries.effect_id IS NULL THEN owners.heartbeat_at_ms + ?
            WHEN recoveries.recovery_timeout_ms > ?
            THEN owners.heartbeat_at_ms + recoveries.recovery_timeout_ms
            ELSE owners.heartbeat_at_ms + ?
          END AS due_at_ms
        FROM ${this.table("effects")} effects
        LEFT JOIN ${this.table("effect_recoveries")} recoveries
          ON recoveries.effect_id = effects.id AND recoveries.recovery_operation IS NOT NULL
        LEFT JOIN ${this.table("processes")} owners
          ON owners.id = effects.claimed_by
          AND (recoveries.effect_id IS NOT NULL OR owners.shutdown_state = 'running')
        WHERE effects.status = 'processing'
      ) due`,
      parameters: [now, threshold, threshold, threshold],
    }))
  }

  untilReminderWork(): Promise<number | undefined> {
    const threshold = this.settings.processAliveThresholdMilliseconds
    return this.untilDue(() => ({
      sql: `SELECT MIN(CASE WHEN stale_at_ms > run_at_ms THEN stale_at_ms ELSE run_at_ms END)
        AS due_at_ms FROM (
        SELECT reminders.run_at_ms AS run_at_ms,
          CASE
            WHEN reminders.claimed_by IS NULL OR owners.id IS NULL THEN reminders.run_at_ms
            WHEN reminders.claimed_at_ms < owners.heartbeat_at_ms
            THEN reminders.claimed_at_ms + ?
            ELSE owners.heartbeat_at_ms + ?
          END AS stale_at_ms
        FROM ${this.table("reminders")} reminders
        LEFT JOIN ${this.table("processes")} owners
          ON owners.id = reminders.claimed_by AND owners.shutdown_state = 'running'
        WHERE reminders.status = 'scheduled'
      ) due`,
      parameters: [threshold, threshold],
    }))
  }

  untilBroadcastWork(): Promise<number | undefined> {
    const threshold = this.settings.processAliveThresholdMilliseconds
    return this.untilDue((now) => ({
      sql: `SELECT MIN(due_at_ms) AS due_at_ms FROM (
        SELECT broadcasts.available_at_ms AS due_at_ms
        FROM ${this.table("broadcasts")} broadcasts
        WHERE broadcasts.status = 'pending' AND NOT EXISTS (
          SELECT 1 FROM ${this.table("broadcasts")} earlier
          WHERE earlier.instance_id = broadcasts.instance_id
            AND earlier.state_revision < broadcasts.state_revision
            AND earlier.status IN ('pending', 'processing')
        )
        UNION ALL
        SELECT CASE WHEN owners.id IS NULL THEN ? ELSE owners.heartbeat_at_ms + ? END AS due_at_ms
        FROM ${this.table("broadcasts")} broadcasts
        LEFT JOIN ${this.table("processes")} owners
          ON owners.id = broadcasts.claimed_by AND owners.shutdown_state = 'running'
        WHERE broadcasts.status = 'processing'
      ) due`,
      parameters: [now, threshold],
    }))
  }

  untilRedriveWork(): Promise<number | undefined> {
    return this.untilDue((now) => ({
      sql: `SELECT MIN(?) AS due_at_ms FROM ${this.table("redrives")} WHERE status = 'running'`,
      parameters: [now],
    }))
  }

  private async untilDue(
    query: (now: number) => { sql: string; parameters: readonly unknown[] },
  ): Promise<number | undefined> {
    return this.settings.database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      const { sql, parameters } = query(now)
      const row = await connection.get<DueRow>(sql, parameters)
      if (row?.due_at_ms === null || row?.due_at_ms === undefined) return undefined
      return Number(row.due_at_ms) - now
    })
  }

  private table(name: string): string {
    return `${this.settings.tableNamePrefix}${name}`
  }
}

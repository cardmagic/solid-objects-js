import type { SolidObjectsRuntime } from "../runtime.js"
import type { DatabaseConnection } from "../database/types.js"

export type DashboardRecord = Record<string, unknown>

export interface DashboardPageResult {
  readonly records: readonly DashboardRecord[]
  readonly page: number
  readonly perPage: number
  readonly total: number
  readonly lastPage: number
}

export interface DashboardStatistics extends DashboardRecord {
  readonly instances: DashboardRecord
  readonly mailbox: DashboardRecord
  readonly effects: DashboardRecord
  readonly broadcasts: DashboardRecord
  readonly reminders: DashboardRecord
  readonly deadLetters: DashboardRecord
  readonly processes: DashboardRecord
  readonly serverTime: string
}

export interface DashboardInstanceDetail {
  readonly instance: DashboardRecord
  readonly readyMessages: readonly DashboardRecord[]
  readonly claimedMessages: readonly DashboardRecord[]
  readonly recentMessages: readonly DashboardRecord[]
  readonly reminders: readonly DashboardRecord[]
  readonly effects: readonly DashboardRecord[]
  readonly broadcasts: readonly DashboardRecord[]
  readonly deadLetters: readonly DashboardRecord[]
}

interface PageOptions {
  readonly page?: string | null
  readonly perPage?: string | null
  readonly status?: string | null
  readonly actorType?: string | null
  readonly actorId?: string | null
  readonly membership?: string | null
}

interface Query {
  readonly from: string
  readonly select?: string
  readonly where?: string
  readonly parameters?: readonly unknown[]
  readonly order: string
}

const EFFECT_STATUSES = ["pending", "processing", "completed", "dead"] as const
const BROADCAST_STATUSES = ["pending", "processing", "delivered", "dead"] as const
const REMINDER_STATUSES = ["scheduled", "paused", "completed"] as const
const PROCESS_STATUSES = ["running", "draining", "stopped"] as const

export class DashboardStore {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async statistics(): Promise<DashboardStatistics> {
    return this.runtime.settings.database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      const [instances, mailbox, effects, broadcasts, reminders, deadLetters, processes] =
        await Promise.all([
          connection.get<DashboardRecord>(
            `SELECT COUNT(*) AS total,
              SUM(CASE WHEN paused = 1 THEN 1 ELSE 0 END) AS paused,
              SUM(CASE WHEN activation_expires_at_ms >= ? THEN 1 ELSE 0 END) AS activated
             FROM ${this.table("instances")}`,
            [now],
          ),
          connection.get<DashboardRecord>(
            `SELECT COUNT(*) AS ready,
              SUM(CASE WHEN available_at_ms <= ? THEN 1 ELSE 0 END) AS due,
              MIN(CASE WHEN available_at_ms <= ? THEN available_at_ms END) AS oldest_due
             FROM ${this.table("ready_messages")}`,
            [now, now],
          ),
          this.grouped({
            connection,
            table: "effects",
            column: "status",
            statuses: EFFECT_STATUSES,
          }),
          this.grouped({
            connection,
            table: "broadcasts",
            column: "status",
            statuses: BROADCAST_STATUSES,
          }),
          this.grouped({
            connection,
            table: "reminders",
            column: "status",
            statuses: REMINDER_STATUSES,
          }),
          connection.get<DashboardRecord>(
            `SELECT COUNT(*) AS total FROM ${this.table("dead_letters")}`,
          ),
          this.grouped({
            connection,
            table: "processes",
            column: "shutdown_state",
            statuses: PROCESS_STATUSES,
          }),
        ])
      const claimed = await connection.get<DashboardRecord>(
        `SELECT COUNT(*) AS total FROM ${this.table("claimed_messages")}`,
      )
      const reminderDue = await connection.get<DashboardRecord>(
        `SELECT COUNT(*) AS total FROM ${this.table("reminders")}
         WHERE status = 'scheduled' AND run_at_ms <= ?`,
        [now],
      )
      const oldestDue = numeric(mailbox?.oldest_due)
      return freezeRecord({
        instances: freezeRecord({
          total: numeric(instances?.total),
          paused: numeric(instances?.paused),
          activated: numeric(instances?.activated),
        }),
        mailbox: freezeRecord({
          ready: numeric(mailbox?.ready),
          due: numeric(mailbox?.due),
          claimed: numeric(claimed?.total),
          latency: oldestDue === 0 ? 0 : Math.max(0, (now - oldestDue) / 1_000),
        }),
        effects,
        broadcasts,
        reminders: freezeRecord({ ...reminders, due: numeric(reminderDue?.total) }),
        deadLetters: freezeRecord({ total: numeric(deadLetters?.total) }),
        processes,
        serverTime: new Date(now).toISOString(),
      }) as DashboardStatistics
    })
  }

  instances(options: PageOptions): Promise<DashboardPageResult> {
    const conditions: string[] = []
    const parameters: unknown[] = []
    if (options.actorType) {
      conditions.push("actor_type = ?")
      parameters.push(options.actorType)
    }
    if (options.actorId) {
      const expression = this.substringExpression("actor_id")
      conditions.push(expression)
      parameters.push(options.actorId)
    }
    return this.page(
      {
        from: this.table("instances"),
        ...(conditions.length === 0 ? {} : { where: conditions.join(" AND ") }),
        parameters,
        order: "updated_at_ms DESC, id DESC",
      },
      options,
    )
  }

  mailbox(options: PageOptions): Promise<DashboardPageResult> {
    const membership = options.membership === "claimed" ? "claimed_messages" : "ready_messages"
    const timeColumn =
      membership === "claimed_messages" ? "membership.claimed_at_ms" : "membership.available_at_ms"
    return this.page(
      {
        from: `${this.table("messages")} messages
          INNER JOIN ${this.table(membership)} membership ON membership.message_id = messages.id`,
        order: `${timeColumn} ASC, messages.id ASC`,
      },
      options,
    )
  }

  reminders(options: PageOptions): Promise<DashboardPageResult> {
    return this.statusPage({
      table: "reminders",
      statuses: REMINDER_STATUSES,
      order: "run_at_ms ASC, id ASC",
      options,
    })
  }

  effects(options: PageOptions): Promise<DashboardPageResult> {
    return this.statusPage({
      table: "effects",
      statuses: EFFECT_STATUSES,
      order: "available_at_ms DESC, id DESC",
      options,
    })
  }

  broadcasts(options: PageOptions): Promise<DashboardPageResult> {
    return this.statusPage({
      table: "broadcasts",
      statuses: BROADCAST_STATUSES,
      order: "available_at_ms DESC, id DESC",
      options,
    })
  }

  deadLetters(options: PageOptions): Promise<DashboardPageResult> {
    return this.page(
      {
        from: `${this.table("dead_letters")} dead_letters
          INNER JOIN ${this.table("messages")} messages ON messages.id = dead_letters.message_id`,
        select:
          "dead_letters.id, dead_letters.message_id, dead_letters.instance_id, dead_letters.attempts, dead_letters.error, dead_letters.created_at_ms, dead_letters.retried_message_id, messages.actor_type, messages.actor_id, messages.operation, messages.delivery_mode, messages.arguments",
        order: "dead_letters.created_at_ms DESC, dead_letters.id DESC",
      },
      options,
    )
  }

  processes(options: PageOptions): Promise<DashboardPageResult> {
    return this.statusPage({
      table: "processes",
      statusColumn: "shutdown_state",
      statuses: PROCESS_STATUSES,
      order: "heartbeat_at_ms DESC, id DESC",
      options,
    })
  }

  async instance(id: string): Promise<DashboardInstanceDetail | undefined> {
    return this.runtime.settings.database.connection(async (connection) => {
      const instance = await connection.get<DashboardRecord>(
        `SELECT * FROM ${this.table("instances")} WHERE id = ?`,
        [id],
      )
      if (!instance) return undefined
      const related = { instanceId: id, limit: 10 }
      const [
        readyMessages,
        claimedMessages,
        recentMessages,
        reminders,
        effects,
        broadcasts,
        deadLetters,
      ] = await Promise.all([
        connection.all<DashboardRecord>(
          `SELECT messages.*, membership.available_at_ms
             FROM ${this.table("messages")} messages
             INNER JOIN ${this.table("ready_messages")} membership ON membership.message_id = messages.id
             WHERE messages.instance_id = ? ORDER BY messages.sequence ASC LIMIT ?`,
          [related.instanceId, related.limit],
        ),
        connection.all<DashboardRecord>(
          `SELECT messages.*, membership.claimed_at_ms
             FROM ${this.table("messages")} messages
             INNER JOIN ${this.table("claimed_messages")} membership ON membership.message_id = messages.id
             WHERE messages.instance_id = ? ORDER BY messages.sequence ASC LIMIT ?`,
          [related.instanceId, related.limit],
        ),
        connection.all<DashboardRecord>(
          `SELECT * FROM ${this.table("messages")} WHERE instance_id = ?
             ORDER BY sequence DESC LIMIT ?`,
          [related.instanceId, related.limit],
        ),
        connection.all<DashboardRecord>(
          `SELECT * FROM ${this.table("reminders")} WHERE instance_id = ?
             ORDER BY run_at_ms ASC LIMIT ?`,
          [related.instanceId, related.limit],
        ),
        connection.all<DashboardRecord>(
          `SELECT * FROM ${this.table("effects")} WHERE instance_id = ?
             ORDER BY available_at_ms DESC LIMIT ?`,
          [related.instanceId, related.limit],
        ),
        connection.all<DashboardRecord>(
          `SELECT * FROM ${this.table("broadcasts")} WHERE instance_id = ?
             ORDER BY available_at_ms DESC LIMIT ?`,
          [related.instanceId, related.limit],
        ),
        connection.all<DashboardRecord>(
          `SELECT dead_letters.*, messages.actor_type, messages.actor_id, messages.operation,
              messages.delivery_mode, messages.arguments
             FROM ${this.table("dead_letters")} dead_letters
             INNER JOIN ${this.table("messages")} messages ON messages.id = dead_letters.message_id
             WHERE dead_letters.instance_id = ? ORDER BY dead_letters.created_at_ms DESC LIMIT ?`,
          [related.instanceId, related.limit],
        ),
      ])
      return Object.freeze({
        instance: freezeRecord(instance),
        readyMessages: freezeRecords(readyMessages),
        claimedMessages: freezeRecords(claimedMessages),
        recentMessages: freezeRecords(recentMessages),
        reminders: freezeRecords(reminders),
        effects: freezeRecords(effects),
        broadcasts: freezeRecords(broadcasts),
        deadLetters: freezeRecords(deadLetters),
      })
    })
  }

  message(id: string): Promise<DashboardRecord | undefined> {
    return this.runtime.settings.database.connection(async (connection) => {
      const record = await connection.get<DashboardRecord>(
        `SELECT messages.*,
          CASE WHEN ready.message_id IS NOT NULL THEN 'ready'
               WHEN claimed.message_id IS NOT NULL THEN 'claimed'
               WHEN messages.completed_at_ms IS NOT NULL THEN 'completed'
               ELSE 'history' END AS membership
         FROM ${this.table("messages")} messages
         LEFT JOIN ${this.table("ready_messages")} ready ON ready.message_id = messages.id
         LEFT JOIN ${this.table("claimed_messages")} claimed ON claimed.message_id = messages.id
         WHERE messages.id = ?`,
        [id],
      )
      return record ? freezeRecord(record) : undefined
    })
  }

  deadLetter(id: string): Promise<DashboardRecord | undefined> {
    return this.runtime.settings.database.connection(async (connection) => {
      const record = await connection.get<DashboardRecord>(
        `SELECT dead_letters.*, messages.actor_type, messages.actor_id, messages.operation,
          messages.delivery_mode, messages.arguments
         FROM ${this.table("dead_letters")} dead_letters
         INNER JOIN ${this.table("messages")} messages ON messages.id = dead_letters.message_id
         WHERE dead_letters.id = ?`,
        [id],
      )
      return record ? freezeRecord(record) : undefined
    })
  }

  async dashboard(): Promise<DashboardRecord> {
    return this.runtime.settings.database.connection(async (connection) => {
      const [processes, deadLetters, instancesByType] = await Promise.all([
        connection.all<DashboardRecord>(
          `SELECT * FROM ${this.table("processes")} ORDER BY heartbeat_at_ms DESC LIMIT 10`,
        ),
        connection.all<DashboardRecord>(
          `SELECT dead_letters.*, messages.actor_type, messages.actor_id, messages.operation
           FROM ${this.table("dead_letters")} dead_letters
           INNER JOIN ${this.table("messages")} messages ON messages.id = dead_letters.message_id
           ORDER BY dead_letters.created_at_ms DESC LIMIT 10`,
        ),
        connection.all<DashboardRecord>(
          `SELECT actor_type, COUNT(*) AS count FROM ${this.table("instances")}
           GROUP BY actor_type ORDER BY count DESC LIMIT 12`,
        ),
      ])
      return freezeRecord({
        processes: freezeRecords(processes),
        deadLetters: freezeRecords(deadLetters),
        instancesByType: freezeRecords(instancesByType),
      })
    })
  }

  async setPaused(options: { id: string; paused: boolean }): Promise<boolean> {
    const result = await this.runtime.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      return connection.run(
        `UPDATE ${this.table("instances")} SET paused = ?, updated_at_ms = ? WHERE id = ?`,
        [options.paused, now, options.id],
      )
    })
    return result.changes > 0
  }

  async healthy(): Promise<void> {
    await this.runtime.settings.database.connection((connection) =>
      connection.get(`SELECT 1 AS healthy FROM ${this.table("schema_migrations")} LIMIT 1`),
    )
  }

  private async page(query: Query, options: PageOptions): Promise<DashboardPageResult> {
    const perPage = boundedInteger(options.perPage, { fallback: 25, maximum: 200 })
    return this.runtime.settings.database.connection(async (connection) => {
      const where = query.where ? ` WHERE ${query.where}` : ""
      const parameters = [...(query.parameters ?? [])]
      const count = await connection.get<{ count: number | bigint }>(
        `SELECT COUNT(*) AS count FROM ${query.from}${where}`,
        parameters,
      )
      const total = numeric(count?.count)
      const lastPage = Math.max(Math.ceil(total / perPage), 1)
      const page = Math.min(
        boundedInteger(options.page, { fallback: 1, maximum: lastPage }),
        lastPage,
      )
      const records = await connection.all<DashboardRecord>(
        `SELECT ${query.select ?? "*"} FROM ${query.from}${where} ORDER BY ${query.order} LIMIT ? OFFSET ?`,
        [...parameters, perPage, (page - 1) * perPage],
      )
      return Object.freeze({
        records: freezeRecords(records),
        page,
        perPage,
        total,
        lastPage,
      })
    })
  }

  private statusPage(options: {
    table: string
    statusColumn?: string
    statuses: readonly string[]
    order: string
    options: PageOptions
  }): Promise<DashboardPageResult> {
    const status = options.statuses.includes(options.options.status ?? "")
      ? options.options.status
      : undefined
    const statusColumn = options.statusColumn ?? "status"
    return this.page(
      {
        from: this.table(options.table),
        ...(status ? { where: `${statusColumn} = ?`, parameters: [status] } : {}),
        order: options.order,
      },
      options.options,
    )
  }

  private async grouped(options: {
    connection: DatabaseConnection
    table: string
    column: string
    statuses: readonly string[]
  }): Promise<DashboardRecord> {
    const { connection, table, column, statuses } = options
    const rows = await connection.all<{ status: string; count: number | bigint }>(
      `SELECT ${column} AS status, COUNT(*) AS count FROM ${this.table(table)} GROUP BY ${column}`,
    )
    const counts = new Map(rows.map((row) => [row.status, numeric(row.count)]))
    return freezeRecord(
      Object.fromEntries(statuses.map((status) => [status, counts.get(status) ?? 0])),
    )
  }

  private substringExpression(column: string): string {
    if (this.runtime.settings.database.family === "sqlite") return `instr(${column}, ?) > 0`
    if (this.runtime.settings.database.family === "postgresql")
      return `POSITION(? IN ${column}) > 0`
    return `LOCATE(?, ${column}) > 0`
  }

  private table(name: string): string {
    return this.runtime.repository.table(name)
  }
}

function boundedInteger(
  value: string | null | undefined,
  options: { fallback: number; maximum: number },
): number {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return options.fallback
  return Math.min(parsed, options.maximum)
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") return Number(value)
  return 0
}

function freezeRecord(record: DashboardRecord): DashboardRecord {
  return Object.freeze(record)
}

function freezeRecords(records: readonly DashboardRecord[]): readonly DashboardRecord[] {
  return Object.freeze(records.map(freezeRecord))
}

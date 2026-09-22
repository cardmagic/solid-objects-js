import type { DatabaseConnection } from "./database/types.js"
import type { RedriveTask } from "./redrive.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import { normalizeJson } from "./serialization.js"
import type { AdministrationOptions, DeepReadonly, JsonObject } from "./types.js"

export type DeadLetterKind = "effect" | "broadcast"

export interface DeadRow {
  readonly id: string
  readonly kind: DeadLetterKind
  readonly actorType: string
  readonly actorId: string
  readonly status: string
  readonly attemptCount: number
  readonly availableAt: Date
  readonly failedAt: Date | null
  readonly error: DeepReadonly<JsonObject> | null
}

export interface RedriveFilters {
  readonly actorType: string | null
  readonly failedAfter: number | null
  readonly limit: number | null
}

export interface RedriveOptions extends AdministrationOptions {
  actorType?: string
  failedAfter?: Date
  limit?: number
}

interface DeadRowShape {
  id: string
  status: string
  attempt_count: number | bigint
  available_at_ms: number | bigint
  failed_at_ms: number | bigint | null
  error: string | null
  actor_type: string
  actor_id: string
}

const TABLES: Readonly<Record<DeadLetterKind, string>> = Object.freeze({
  effect: "effects",
  broadcast: "broadcasts",
})

const RESOURCES: Readonly<Record<DeadLetterKind, string>> = Object.freeze({
  effect: "effect_dead_letters",
  broadcast: "broadcast_dead_letters",
})

export class DeadLetterScope {
  constructor(
    private readonly runtime: SolidObjectsRuntime,
    readonly kind: DeadLetterKind,
  ) {}

  get resource(): string {
    return RESOURCES[this.kind]
  }

  async all(options: AdministrationOptions = {}): Promise<readonly DeadRow[]> {
    await this.authorize({ action: "inspect", options })
    const rows = await this.runtime.settings.database.connection((connection) =>
      this.matching({ connection, filters: emptyFilters() }),
    )
    return Object.freeze(rows.map((row) => this.deadRow(row)))
  }

  async retry(id: string, options: AdministrationOptions = {}): Promise<DeadRow> {
    await this.authorize({ action: "retry", options, resourceId: id })
    await this.runtime.recordAdministrationEvent({
      action: "dead_letter.retry",
      kind: this.kind,
      subjectId: id,
      authorizationContext: options.authorizationContext,
    })
    const row = await this.runtime.settings.database.transaction(async (connection) => {
      const found = await this.find({ connection, id })
      if (found.status === "dead") await this.revive({ connection, identifiers: [id] })
      return await this.find({ connection, id })
    })
    this.runtime.wakeUpAfterRevival(this.kind)
    return this.deadRow(row)
  }

  async redrive(options: RedriveOptions = {}): Promise<RedriveTask> {
    return await this.runtime.redrives.start({
      kind: this.kind,
      filters: {
        actorType: options.actorType ?? null,
        failedAfter: options.failedAfter ? options.failedAfter.getTime() : null,
        limit: options.limit ?? null,
      },
      authorizationContext: options.authorizationContext,
    })
  }

  async count(input: {
    connection: DatabaseConnection
    filters: RedriveFilters
    deadBefore?: number
  }): Promise<number> {
    const { where, parameters } = this.conditions(input.filters, input.deadBefore)
    const row = await input.connection.get<{ total: number | bigint }>(
      `SELECT COUNT(*) AS total FROM ${this.table()} AS dead
       JOIN ${this.runtime.repository.table("instances")} AS owner ON owner.id = dead.instance_id
       ${where}`,
      parameters,
    )
    return Number(row?.total ?? 0)
  }

  async matching(input: {
    connection: DatabaseConnection
    filters: RedriveFilters
    limit?: number
    deadBefore?: number
  }): Promise<DeadRowShape[]> {
    const { where, parameters } = this.conditions(input.filters, input.deadBefore)
    const limit = input.limit === undefined ? "" : ` LIMIT ${Number(input.limit)}`
    return await input.connection.all<DeadRowShape>(
      `SELECT dead.id, dead.status, dead.attempt_count, dead.available_at_ms,
              dead.failed_at_ms, dead.error, owner.actor_type, owner.actor_id
       FROM ${this.table()} AS dead
       JOIN ${this.runtime.repository.table("instances")} AS owner ON owner.id = dead.instance_id
       ${where}
       ORDER BY dead.failed_at_ms DESC, dead.id DESC${limit}`,
      parameters,
    )
  }

  async revive(input: {
    connection: DatabaseConnection
    identifiers: readonly string[]
  }): Promise<number> {
    if (input.identifiers.length === 0) return 0
    const placeholders = input.identifiers.map(() => "?").join(", ")
    const now = await input.connection.nowMilliseconds()
    const result = await input.connection.run(
      `UPDATE ${this.table()}
       SET status = 'pending', attempt_count = 0, available_at_ms = ?, claimed_by = NULL
       WHERE status = 'dead' AND id IN (${placeholders})`,
      [now, ...input.identifiers],
    )
    return result.changes
  }

  private table(): string {
    return this.runtime.repository.table(TABLES[this.kind])
  }

  // A redrive moves what was already dead when it started. Without that bound a
  // row that fails again lands back in the same scope, and a task whose handler
  // is still broken would move it forever.
  private conditions(
    filters: RedriveFilters,
    deadBefore?: number,
  ): { where: string; parameters: unknown[] } {
    const clauses = ["dead.status = 'dead'"]
    const parameters: unknown[] = []
    if (deadBefore !== undefined) {
      clauses.push("dead.failed_at_ms <= ?")
      parameters.push(deadBefore)
    }
    if (filters.actorType !== null) {
      clauses.push("owner.actor_type = ?")
      parameters.push(filters.actorType)
    }
    if (filters.failedAfter !== null) {
      clauses.push("dead.failed_at_ms >= ?")
      parameters.push(filters.failedAfter)
    }
    return { where: `WHERE ${clauses.join(" AND ")}`, parameters }
  }

  private async find(input: { connection: DatabaseConnection; id: string }): Promise<DeadRowShape> {
    const row = await input.connection.get<DeadRowShape>(
      `SELECT dead.id, dead.status, dead.attempt_count, dead.available_at_ms,
              dead.failed_at_ms, dead.error, owner.actor_type, owner.actor_id
       FROM ${this.table()} AS dead
       JOIN ${this.runtime.repository.table("instances")} AS owner ON owner.id = dead.instance_id
       WHERE dead.id = ?`,
      [input.id],
    )
    if (!row) throw new UnknownDeadRow(`unknown ${this.kind} ${input.id}`)
    return row
  }

  private deadRow(row: DeadRowShape): DeadRow {
    return Object.freeze({
      id: row.id,
      kind: this.kind,
      actorType: row.actor_type,
      actorId: row.actor_id,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      availableAt: new Date(Number(row.available_at_ms)),
      failedAt: row.failed_at_ms === null ? null : new Date(Number(row.failed_at_ms)),
      error: row.error === null ? null : (normalizeJson(JSON.parse(row.error)) as JsonObject),
    })
  }

  async authorize(input: {
    action: string
    options: AdministrationOptions
    resourceId?: string
  }): Promise<void> {
    await this.runtime.authorizeAdministration({
      action: input.action,
      resource: this.resource,
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      authorizationContext: input.options.authorizationContext,
    })
  }
}

export function emptyFilters(): RedriveFilters {
  return Object.freeze({ actorType: null, failedAfter: null, limit: null })
}

export class UnknownDeadRow extends Error {
  override readonly name = "UnknownDeadRow"
}

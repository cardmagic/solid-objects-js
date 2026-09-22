import type { DatabaseConnection } from "./database/types.js"
import type { DeadLetterKind, RedriveFilters } from "./dead-letter-scopes.js"
import { randomUUID, sha256Hex } from "./platform/uuid.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import type { AdministrationOptions } from "./types.js"
import { waitFor } from "./worker.js"

export type RedriveStatus = "running" | "completed" | "cancelled"

export interface RedriveTask {
  readonly id: string
  readonly kind: DeadLetterKind
  readonly filters: RedriveFilters
  readonly status: RedriveStatus
  readonly moved: number
  readonly remaining: number
  readonly startedAt: Date
  readonly finishedAt: Date | null
  cancel(options?: AdministrationOptions): Promise<RedriveTask>
}

interface RedriveShape {
  id: string
  kind: DeadLetterKind
  filters: string
  status: RedriveStatus
  active_scope: string | null
  moved: number | bigint
  move_limit: number | bigint | null
  actor: string | null
  started_at_ms: number | bigint
  finished_at_ms: number | bigint | null
}

export class RedriveManager {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async start(input: {
    kind: DeadLetterKind
    filters: RedriveFilters
    authorizationContext?: AdministrationOptions["authorizationContext"]
  }): Promise<RedriveTask> {
    await this.runtime.deadLetters.scope(input.kind).authorize({
      action: "redrive",
      options: { authorizationContext: input.authorizationContext },
    })
    const activeScope = await activeScopeFor(input)
    const existing = await this.findRow(activeScope, "active_scope")
    if (existing) return await this.task(existing)

    const actor = await this.runtime.administrationIdentity(input.authorizationContext)
    const opened = await this.open({ ...input, activeScope, actor })
    return await this.task(opened)
  }

  async find(id: string, options: AdministrationOptions = {}): Promise<RedriveTask> {
    await this.authorize({ action: "inspect", options, resourceId: id })
    return await this.task(await this.require(id))
  }

  async all(
    options: AdministrationOptions & { status?: RedriveStatus } = {},
  ): Promise<readonly RedriveTask[]> {
    await this.authorize({ action: "inspect", options })
    const status = options.status
    const rows = await this.runtime.settings.database.connection((connection) =>
      connection.all<RedriveShape>(
        `SELECT * FROM ${this.table()}
         ${status === undefined ? "" : "WHERE status = ?"}
         ORDER BY started_at_ms DESC, id DESC`,
        status === undefined ? [] : [status],
      ),
    )
    return Object.freeze(await Promise.all(rows.map((row) => this.task(row))))
  }

  async cancel(id: string, options: AdministrationOptions = {}): Promise<RedriveTask> {
    await this.authorize({ action: "cancel", options, resourceId: id })
    const row = await this.require(id)
    if (row.status !== "running") return await this.task(row)

    await this.runtime.settings.database.transaction((connection) =>
      this.close({ connection, row, status: "cancelled", action: "redrive.cancel" }),
    )
    return await this.task(await this.require(id))
  }

  async advance(): Promise<boolean> {
    const outcome = await this.runtime.settings.database.transaction(async (connection) => {
      const row = await this.claim(connection)
      if (!row) return { moved: 0, kind: undefined }

      const moved = await this.moveBatch({ connection, row })
      if (moved > 0) return { moved, kind: row.kind }

      await this.close({ connection, row, status: "completed", action: "redrive.finish" })
      return { moved: 0, kind: undefined }
    })
    if (outcome.kind) this.runtime.wakeUpAfterRevival(outcome.kind)
    return outcome.moved > 0
  }

  private async claim(connection: DatabaseConnection): Promise<RedriveShape | undefined> {
    return await connection.get<RedriveShape>(
      `SELECT * FROM ${this.table()} WHERE status = 'running'
       ORDER BY started_at_ms, id LIMIT 1${this.lockClause()}`,
    )
  }

  private lockClause(): string {
    return this.runtime.settings.database.family === "sqlite" ? "" : " FOR UPDATE SKIP LOCKED"
  }

  private async moveBatch(input: {
    connection: DatabaseConnection
    row: RedriveShape
  }): Promise<number> {
    const { connection, row } = input
    const size = this.batchSize(row)
    if (size <= 0) return 0

    const scope = this.runtime.deadLetters.scope(row.kind)
    const candidates = await scope.matching({
      connection,
      filters: parseFilters(row.filters),
      limit: size,
      deadBefore: Number(row.started_at_ms),
    })
    if (candidates.length === 0) return 0

    const revived = await scope.revive({
      connection,
      identifiers: candidates.map(({ id }) => id),
    })
    await connection.run(
      `UPDATE ${this.table()} SET moved = moved + ? WHERE id = ? AND status = 'running'`,
      [revived, row.id],
    )
    return revived
  }

  private batchSize(row: RedriveShape): number {
    const configured = this.runtime.settings.redriveBatchSize
    if (row.move_limit === null) return configured
    return Math.min(configured, Number(row.move_limit) - Number(row.moved))
  }

  private async open(input: {
    kind: DeadLetterKind
    filters: RedriveFilters
    activeScope: string
    actor: string | null
  }): Promise<RedriveShape> {
    const id = `redrive_${randomUUID()}`
    try {
      await this.runtime.settings.database.transaction(async (connection) => {
        const now = await connection.nowMilliseconds()
        await connection.run(
          `INSERT INTO ${this.table()}
           (id, kind, filters, status, active_scope, moved, move_limit, actor, started_at_ms)
           VALUES (?, ?, ?, 'running', ?, 0, ?, ?, ?)`,
          [
            id,
            input.kind,
            JSON.stringify(input.filters),
            input.activeScope,
            input.filters.limit,
            input.actor,
            now,
          ],
        )
        await this.runtime.writeAdministrationEvent({
          connection,
          action: "redrive.start",
          kind: input.kind,
          subjectId: id,
          filters: input.filters,
          actor: input.actor,
        })
      })
    } catch {
      const running = await this.findRow(input.activeScope, "active_scope")
      if (running) return running
      throw new RedriveNotStarted(`could not start a ${input.kind} redrive`)
    }
    return await this.require(id)
  }

  private async close(input: {
    connection: DatabaseConnection
    row: RedriveShape
    status: RedriveStatus
    action: string
  }): Promise<void> {
    const now = await input.connection.nowMilliseconds()
    const result = await input.connection.run(
      `UPDATE ${this.table()} SET status = ?, active_scope = NULL, finished_at_ms = ?
       WHERE id = ? AND status = 'running'`,
      [input.status, now, input.row.id],
    )
    if (result.changes === 0) return

    await this.runtime.writeAdministrationEvent({
      connection: input.connection,
      action: input.action,
      kind: input.row.kind,
      subjectId: input.row.id,
      filters: parseFilters(input.row.filters),
      actor: input.row.actor,
    })
  }

  private async task(row: RedriveShape): Promise<RedriveTask> {
    const manager = this
    return Object.freeze({
      id: row.id,
      kind: row.kind,
      filters: parseFilters(row.filters),
      status: row.status,
      moved: Number(row.moved),
      remaining: await this.remaining(row),
      startedAt: new Date(Number(row.started_at_ms)),
      finishedAt: row.finished_at_ms === null ? null : new Date(Number(row.finished_at_ms)),
      cancel(options: AdministrationOptions = {}): Promise<RedriveTask> {
        return manager.cancel(row.id, options)
      },
    })
  }

  private async remaining(row: RedriveShape): Promise<number> {
    if (row.status !== "running") return 0

    const scope = this.runtime.deadLetters.scope(row.kind)
    const matching = await this.runtime.settings.database.connection((connection) =>
      scope.count({
        connection,
        filters: parseFilters(row.filters),
        deadBefore: Number(row.started_at_ms),
      }),
    )
    if (row.move_limit === null) return matching
    return Math.min(matching, Number(row.move_limit) - Number(row.moved))
  }

  private async require(id: string): Promise<RedriveShape> {
    const row = await this.findRow(id, "id")
    if (!row) throw new UnknownRedrive(`unknown redrive ${id}`)
    return row
  }

  private async findRow(
    value: string,
    column: "id" | "active_scope",
  ): Promise<RedriveShape | undefined> {
    return await this.runtime.settings.database.connection((connection: DatabaseConnection) =>
      connection.get<RedriveShape>(`SELECT * FROM ${this.table()} WHERE ${column} = ?`, [value]),
    )
  }

  private table(): string {
    return this.runtime.repository.table("redrives")
  }

  private async authorize(input: {
    action: string
    options: AdministrationOptions
    resourceId?: string
  }): Promise<void> {
    await this.runtime.authorizeAdministration({
      action: input.action,
      resource: "redrives",
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      authorizationContext: input.options.authorizationContext,
    })
  }
}

export class RedriveScheduler {
  private stopping = false

  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopping) {
      const moved = await this.advance()
      await waitFor(this.pauseMilliseconds(moved), signal)
    }
  }

  requestShutdown(): void {
    this.stopping = true
  }

  stopped(): boolean {
    return this.stopping
  }

  stop(): void {
    this.stopping = true
  }

  private async advance(): Promise<boolean> {
    try {
      return await this.runtime.redrives.advance()
    } catch (error) {
      this.runtime.emitInstrumentation("supervisor.redrive_failed", {
        errorName: error instanceof Error ? error.name : "Error",
      })
      return false
    }
  }

  private pauseMilliseconds(moved: boolean): number {
    if (moved) return this.runtime.settings.redriveBatchPauseMilliseconds
    return this.runtime.settings.idlePollingIntervalMilliseconds
  }
}

async function activeScopeFor(input: {
  kind: DeadLetterKind
  filters: RedriveFilters
}): Promise<string> {
  return `${input.kind}:${await sha256Hex(JSON.stringify(input.filters))}`
}

function parseFilters(filters: string): RedriveFilters {
  return Object.freeze(JSON.parse(filters) as RedriveFilters)
}

export class UnknownRedrive extends Error {
  override readonly name = "UnknownRedrive"
}

export class RedriveNotStarted extends Error {
  override readonly name = "RedriveNotStarted"
}

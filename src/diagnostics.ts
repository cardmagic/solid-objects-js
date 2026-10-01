import type { SolidObjectsRuntime } from "./runtime.js"
import type { SnapshotOptions } from "./types.js"

export interface DiagnosticSummary {
  readonly sampled: number
  readonly truncated: boolean
  readonly oldestAgeMilliseconds: number | null
}

export interface ActorDiagnostics {
  readonly actorType: string
  readonly actorId: string
  readonly incarnation: string | null
  readonly revision: string | null
  readonly adapter: string
  readonly occurredAt: string
  readonly limit: number
  readonly mailbox: DiagnosticSummary
  readonly outbox: DiagnosticSummary
  readonly reminders: DiagnosticSummary
  readonly retries: DiagnosticSummary
  readonly recoveryFailures: DiagnosticSummary
}

export interface DiagnosticOptions extends SnapshotOptions {
  limit?: number
}

export function diagnosticLimit(limit = 100): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("diagnostic limit must be an integer between 1 and 100")
  return limit
}

export async function actorDiagnostics(options: {
  runtime: SolidObjectsRuntime
  actorType: string
  actorId: string
  options: DiagnosticOptions
}): Promise<ActorDiagnostics> {
  const { runtime, actorType, actorId } = options
  await runtime.authorizeAdministration({
    action: "inspect",
    resource: "actor_diagnostics",
    resourceId: JSON.stringify([actorType, actorId]),
    authorizationContext: options.options.authorizationContext,
  })
  const limit = diagnosticLimit(options.options.limit)
  const instance = await runtime.repository.findInstanceByIdentity(actorType, actorId)
  return runtime.settings.database.connection(async (connection) => {
    const now = await connection.nowMilliseconds()
    const table = (name: string) => runtime.repository.table(name)
    const queries = {
      mailbox: `SELECT available_at_ms AS at FROM ${table("ready_messages")} WHERE instance_id = ? UNION ALL SELECT claimed_at_ms AS at FROM ${table("claimed_messages")} WHERE instance_id = ?`,
      outbox: `SELECT available_at_ms AS at FROM ${table("effects")} WHERE instance_id = ? AND status IN ('pending', 'processing') UNION ALL SELECT available_at_ms AS at FROM ${table("broadcasts")} WHERE instance_id = ? AND status IN ('pending', 'processing')`,
      reminders: `SELECT run_at_ms AS at FROM ${table("reminders")} WHERE instance_id = ? AND status IN ('scheduled', 'paused')`,
      retries: `SELECT ready.available_at_ms AS at FROM ${table("ready_messages")} ready JOIN ${table("messages")} message ON message.id = ready.message_id WHERE ready.instance_id = ? AND message.attempt_count > 0 AND message.error IS NOT NULL`,
      recoveryFailures: `SELECT dead.created_at_ms AS at FROM ${table("dead_letters")} dead JOIN ${table("messages")} message ON message.id = dead.message_id WHERE dead.instance_id = ? AND message.delivery_mode = 'internal' AND message.idempotency_key LIKE 'effect:%:recovery'`,
    }
    const summarize = async (name: keyof typeof queries): Promise<DiagnosticSummary> => {
      const parameters = [instance?.id ?? ""]
      if (name === "mailbox" || name === "outbox") parameters.push(instance?.id ?? "")
      const rows = instance
        ? await connection.all<{ at: number | bigint }>(
            `${queries[name]} ORDER BY at LIMIT ${limit + 1}`,
            parameters,
          )
        : []
      return diagnosticSummary({
        timestamps: rows.map((row) => Number(row.at)),
        now,
        limit,
      })
    }
    const result: ActorDiagnostics = Object.freeze({
      actorType,
      actorId,
      incarnation: instance?.id ?? null,
      revision: instance ? String(instance.state_revision) : null,
      adapter: runtime.settings.database.family,
      occurredAt: new Date(now).toISOString(),
      limit,
      mailbox: await summarize("mailbox"),
      outbox: await summarize("outbox"),
      reminders: await summarize("reminders"),
      retries: await summarize("retries"),
      recoveryFailures: await summarize("recoveryFailures"),
    })
    runtime.emitInstrumentation("mailbox.depth", {
      actorType,
      actorId,
      instanceId: instance?.id ?? null,
      count: result.mailbox.sampled,
      truncated: result.mailbox.truncated,
      depth: result.mailbox.truncated ? null : result.mailbox.sampled,
    })
    return result
  })
}

export function diagnosticSummary(options: {
  timestamps: number[]
  now: number
  limit: number
}): DiagnosticSummary {
  return Object.freeze({
    sampled: Math.min(options.timestamps.length, options.limit),
    truncated: options.timestamps.length > options.limit,
    oldestAgeMilliseconds:
      options.timestamps.length === 0
        ? null
        : Math.max(0, options.now - Math.min(...options.timestamps)),
  })
}

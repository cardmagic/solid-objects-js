import type { EffectRecoveryIntent } from "./actor.js"
import type { RuntimeSettings } from "./configuration.js"
import type { DatabaseConnection } from "./database/types.js"
import { NonRetryableError } from "./errors.js"
import {
  EffectRecoveryOutcome,
  type EffectRecoveryPayload,
  type EffectRetiredPayload,
} from "./effect-recovery.js"
import type { EffectRow, EnqueueInput, MessageRow, ProcessRow } from "./records.js"
import { jsonObject, normalizeJson } from "./serialization.js"
import type { WakeUpAdapter } from "./wake-up.js"
import { notifyWakeUp } from "./wake-up-notification.js"

interface RecoveryBinding {
  effect_id: string
  instance_id: string
  recovery_operation: string | null
  status_operation: string | null
  recovery_timeout_ms: number | bigint | null
  retired_at_ms: number | bigint | null
}

interface Origin {
  id: string
  actor_type: string
  actor_id: string
}

export class EffectRecoveryCoordinator {
  constructor(
    private readonly options: {
      settings: RuntimeSettings
      wakeUpAdapter: () => Promise<WakeUpAdapter>
      enqueue: (connection: DatabaseConnection, input: EnqueueInput) => Promise<MessageRow>
    },
  ) {}

  async recoverAvailable(): Promise<void> {
    const candidates = await this.options.settings.database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      const threshold = this.options.settings.processAliveThresholdMilliseconds
      return connection.all<RecoveryBinding>(
        `SELECT recoveries.* FROM ${this.table("effect_recoveries")} recoveries
       JOIN ${this.table("effects")} effects ON effects.id = recoveries.effect_id
       LEFT JOIN ${this.table("processes")} owners ON owners.id = effects.claimed_by
       WHERE recoveries.retired_at_ms IS NULL AND recoveries.recovery_operation IS NOT NULL
         AND effects.status = 'processing'
         AND (owners.id IS NULL OR owners.heartbeat_at_ms <= ? -
           CASE WHEN recoveries.recovery_timeout_ms > ? THEN recoveries.recovery_timeout_ms ELSE ? END)
         ORDER BY recoveries.instance_id, recoveries.effect_id LIMIT ?`,
        [now, threshold, threshold, this.options.settings.claimScanLimit],
      )
    })
    for (const candidate of candidates) {
      const retired = await this.options.settings.database.transaction(async (connection) => {
        const origin = await connection.get<Origin>(
          `SELECT id, actor_type, actor_id FROM ${this.table("instances")} WHERE id = ?${this.lockClause()}`,
          [candidate.instance_id],
        )
        if (!origin) return
        const effect = await connection.get<EffectRow>(
          `SELECT * FROM ${this.table("effects")} WHERE id = ? AND instance_id = ?${this.lockClause()}`,
          [candidate.effect_id, origin.id],
        )
        const binding = await connection.get<RecoveryBinding>(
          `SELECT * FROM ${this.table("effect_recoveries")} WHERE effect_id = ? AND instance_id = ?${this.lockClause()}`,
          [candidate.effect_id, origin.id],
        )
        if (
          !effect ||
          !binding ||
          !binding.recovery_operation ||
          binding.retired_at_ms !== null ||
          effect.status !== "processing"
        )
          return
        const owner =
          effect.claimed_by === null
            ? undefined
            : await connection.get<ProcessRow>(
                `SELECT * FROM ${this.table("processes")} WHERE id = ?${this.lockClause()}`,
                [effect.claimed_by],
              )
        const now = await connection.nowMilliseconds()
        if (this.ownerFresh({ binding, owner, now })) return
        await this.retire({ connection, origin, binding, effect, now })
        return true
      })
      if (retired)
        notifyWakeUp({
          adapter: await this.options.wakeUpAdapter(),
          logger: this.options.settings.logger,
          role: "actors",
        })
    }
  }

  async check(options: {
    connection: DatabaseConnection
    origin: Origin
    intents: readonly EffectRecoveryIntent[]
  }): Promise<void> {
    const { connection, origin, intents } = options
    const effectIds = [...new Set(intents.map((intent) => intent.effectId))].sort()
    if (effectIds.length === 0) return
    const placeholders = effectIds.map(() => "?").join(", ")
    const effects = new Map(
      (
        await connection.all<EffectRow>(
          `SELECT * FROM ${this.table("effects")} WHERE instance_id = ? AND id IN (${placeholders}) ORDER BY id${this.lockClause()}`,
          [origin.id, ...effectIds],
        )
      ).map((effect) => [effect.id, effect]),
    )
    const bindings = new Map(
      (
        await connection.all<RecoveryBinding>(
          `SELECT * FROM ${this.table("effect_recoveries")} WHERE instance_id = ? AND effect_id IN (${placeholders}) ORDER BY effect_id${this.lockClause()}`,
          [origin.id, ...effectIds],
        )
      ).map((binding) => [binding.effect_id, binding]),
    )
    for (const id of effectIds) {
      const binding = bindings.get(id)
      if (!binding?.recovery_operation || !binding.status_operation) {
        throw new NonRetryableError(
          "effect recovery requires an owned handle with onRecovery and onStatus",
        )
      }
    }
    const ownerIds = [
      ...new Set(
        [...effects.values()].flatMap((effect) =>
          effect.claimed_by === null ? [] : [effect.claimed_by],
        ),
      ),
    ].sort()
    const owners = new Map<string, ProcessRow>()
    for (const id of ownerIds) {
      const owner = await connection.get<ProcessRow>(
        `SELECT * FROM ${this.table("processes")} WHERE id = ?${this.lockClause()}`,
        [id],
      )
      if (owner) owners.set(id, owner)
    }
    const now = await connection.nowMilliseconds()
    for (const intent of intents) {
      const binding = bindings.get(intent.effectId)!
      const effect = effects.get(intent.effectId)
      const idempotencyKey = `effect:${intent.effectId}:check:${intent.requestId}`
      const existing = await connection.get<{ id: string }>(
        `SELECT id FROM ${this.table("messages")} WHERE instance_id = ? AND idempotency_key = ?`,
        [origin.id, idempotencyKey],
      )
      if (existing) continue
      const payload = this.observe({ binding, effect, owners, now })
      if (payload.outcome === EffectRecoveryOutcome.Retired && effect) {
        await this.retire({ connection, origin, binding, effect, now })
      }
      await this.options.enqueue(connection, {
        actorType: origin.actor_type,
        actorId: origin.actor_id,
        operation: binding.status_operation!,
        deliveryMode: "internal",
        arguments: jsonObject(payload),
        idempotencyKey,
      })
    }
  }

  private observe(options: {
    binding: RecoveryBinding
    effect: EffectRow | undefined
    owners: ReadonlyMap<string, ProcessRow>
    now: number
  }): EffectRecoveryPayload {
    const { binding, effect, owners, now } = options
    const effectId = binding.effect_id
    if (binding.retired_at_ms !== null)
      return { effectId, outcome: EffectRecoveryOutcome.AlreadyRetired }
    if (!effect) return { effectId, outcome: EffectRecoveryOutcome.Missing }
    const argumentsValue = jsonObject(JSON.parse(effect.arguments))
    if (effect.status === "completed")
      return {
        effectId,
        arguments: argumentsValue,
        outcome: EffectRecoveryOutcome.Completed,
        result: normalizeJson(JSON.parse(effect.result ?? "null")),
      }
    if (effect.status === "dead")
      return { effectId, arguments: argumentsValue, outcome: EffectRecoveryOutcome.Dead }
    if (effect.status === "pending")
      return { effectId, arguments: argumentsValue, outcome: EffectRecoveryOutcome.Pending }
    const owner = effect.claimed_by === null ? undefined : owners.get(effect.claimed_by)
    if (this.ownerFresh({ binding, owner, now }))
      return { effectId, arguments: argumentsValue, outcome: EffectRecoveryOutcome.Deferred }
    return { effectId, arguments: argumentsValue, outcome: EffectRecoveryOutcome.Retired }
  }

  private ownerFresh(options: {
    binding: RecoveryBinding
    owner: ProcessRow | undefined
    now: number
  }): boolean {
    const timeout = Math.max(
      this.options.settings.processAliveThresholdMilliseconds,
      Number(options.binding.recovery_timeout_ms ?? 0),
    )
    return (
      options.owner !== undefined && Number(options.owner.heartbeat_at_ms) > options.now - timeout
    )
  }

  private async retire(options: {
    connection: DatabaseConnection
    origin: Origin
    binding: RecoveryBinding
    effect: EffectRow
    now: number
  }): Promise<void> {
    const { connection, origin, binding, effect, now } = options
    await connection.run(
      `UPDATE ${this.table("effects")} SET status = 'completed', claimed_by = NULL WHERE id = ?`,
      [effect.id],
    )
    await connection.run(
      `UPDATE ${this.table("effect_recoveries")} SET retired_at_ms = ? WHERE effect_id = ?`,
      [now, effect.id],
    )
    const payload: EffectRetiredPayload = {
      effectId: effect.id,
      arguments: jsonObject(JSON.parse(effect.arguments)),
      outcome: EffectRecoveryOutcome.Retired,
    }
    await this.options.enqueue(connection, {
      actorType: origin.actor_type,
      actorId: origin.actor_id,
      operation: binding.recovery_operation!,
      deliveryMode: "internal",
      arguments: jsonObject(payload),
      idempotencyKey: `effect:${effect.id}:recovery`,
    })
    binding.retired_at_ms = now
  }

  private table(name: string): string {
    return `${this.options.settings.tableNamePrefix}${name}`
  }
  private lockClause(): string {
    return this.options.settings.database.family === "sqlite" ? "" : " FOR UPDATE"
  }
}

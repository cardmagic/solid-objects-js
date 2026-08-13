import { randomUUID } from "node:crypto"
import {
  ActorDestroyed,
  IdempotencyConflict,
  LostActivation,
  MailboxFull,
  UnknownDeadLetter,
} from "./errors.js"
import type { ActorIntents } from "./actor.js"
import type { RuntimeSettings } from "./configuration.js"
import type { DatabaseConnection } from "./database/types.js"
import type {
  BroadcastRow,
  ClaimedTurn,
  DeadLetterRow,
  EffectRow,
  EnqueueInput,
  InstanceRow,
  MessageRow,
  ReminderRow,
} from "./records.js"
import { jsonObject, normalizeJson } from "./serialization.js"
import type { JsonObject, JsonValue } from "./types.js"

export class Repository {
  constructor(private readonly settings: RuntimeSettings) {}

  table(name: string): string {
    return `${this.settings.tableNamePrefix}${name}`
  }

  async registerProcess(processId: string, kind: string): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      await connection.run(
        `INSERT INTO ${this.table("processes")}
         (id, kind, started_at_ms, heartbeat_at_ms, shutdown_state)
         VALUES (?, ?, ?, ?, 'running')
         ON CONFLICT(id) DO UPDATE SET heartbeat_at_ms = excluded.heartbeat_at_ms,
           stopped_at_ms = NULL, shutdown_state = 'running'`,
        [processId, kind, now, now],
      )
    })
  }

  async stopProcess(processId: string): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      await connection.run(
        `UPDATE ${this.table("processes")} SET shutdown_state = 'stopped', stopped_at_ms = ?, heartbeat_at_ms = ? WHERE id = ?`,
        [now, now, processId],
      )
      await connection.run(
        `UPDATE ${this.table("instances")} SET activation_owner_id = NULL, activation_token = NULL,
         activation_expires_at_ms = NULL WHERE activation_owner_id = ?`,
        [processId],
      )
    })
  }

  async heartbeatProcess(processId: string): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      await connection.run(
        `UPDATE ${this.table("processes")} SET heartbeat_at_ms = ?
         WHERE id = ? AND shutdown_state = 'running'`,
        [now, processId],
      )
    })
  }

  async enqueue(input: EnqueueInput): Promise<MessageRow> {
    return this.settings.database.transaction(async (connection) =>
      this.enqueueInTransaction(connection, input),
    )
  }

  async enqueueInTransaction(
    connection: DatabaseConnection,
    input: EnqueueInput,
  ): Promise<MessageRow> {
    const now = await connection.nowMilliseconds()
    let instance = await this.findInstance({
      connection,
      actorType: input.actorType,
      actorId: input.actorId,
    })
    if (!instance) {
      const instanceId = randomUUID()
      await connection.run(
        `INSERT INTO ${this.table("instances")}
         (id, actor_type, actor_id, state, state_version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(actor_type, actor_id) DO NOTHING`,
        [
          instanceId,
          input.actorType,
          input.actorId,
          JSON.stringify(input.initialState ?? {}),
          input.stateVersion ?? 1,
          now,
          now,
        ],
      )
      instance = await this.findInstance({
        connection,
        actorType: input.actorType,
        actorId: input.actorId,
      })
    }
    if (!instance) throw new ActorDestroyed("actor disappeared during enqueue")

    if (input.idempotencyKey) {
      const existing = await connection.get<MessageRow>(
        `SELECT * FROM ${this.table("messages")} WHERE actor_type = ? AND actor_id = ? AND request_id = ?`,
        [input.actorType, input.actorId, input.idempotencyKey],
      )
      if (existing) {
        if (
          existing.operation !== input.operation ||
          existing.arguments !== JSON.stringify(input.arguments)
        ) {
          throw new IdempotencyConflict("idempotency key identifies a different invocation")
        }
        return existing
      }
    }

    const live = await connection.get<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM (
        SELECT message_id FROM ${this.table("ready_messages")} WHERE instance_id = ?
        UNION ALL
        SELECT message_id FROM ${this.table("claimed_messages")} WHERE instance_id = ?
      )`,
      [instance.id, instance.id],
    )
    if (Number(live?.count ?? 0) >= this.settings.maxMailboxLength) {
      throw new MailboxFull(
        `mailbox is full for ${input.actorType}(${JSON.stringify(input.actorId)})`,
      )
    }

    const sequence = BigInt(instance.next_message_sequence)
    const messageId = randomUUID()
    const requestId = input.idempotencyKey ?? randomUUID()
    await connection.run(
      `UPDATE ${this.table("instances")} SET next_message_sequence = next_message_sequence + 1,
       updated_at_ms = ? WHERE id = ?`,
      [now, instance.id],
    )
    await connection.run(
      `INSERT INTO ${this.table("messages")}
       (id, request_id, instance_id, actor_type, actor_id, sequence, operation, delivery_mode,
        arguments, max_attempts, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        requestId,
        instance.id,
        input.actorType,
        input.actorId,
        sequence,
        input.operation,
        input.deliveryMode,
        JSON.stringify(input.arguments),
        this.settings.maxAttempts,
        now,
        now,
      ],
    )
    await connection.run(
      `INSERT INTO ${this.table("ready_messages")}(message_id, instance_id, sequence, available_at_ms)
       VALUES (?, ?, ?, ?)`,
      [messageId, instance.id, sequence, input.availableAtMilliseconds ?? now],
    )
    const message = await connection.get<MessageRow>(
      `SELECT * FROM ${this.table("messages")} WHERE id = ?`,
      [messageId],
    )
    if (!message) throw new Error("enqueued message could not be read")
    return message
  }

  async claim(processId: string): Promise<ClaimedTurn | undefined> {
    return this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      await this.recoverExpiredClaims(connection, now)
      const candidate = await connection.get<{ message_id: string; instance_id: string }>(
        `SELECT ready.message_id, ready.instance_id
         FROM ${this.table("ready_messages")} ready
         JOIN ${this.table("instances")} instances ON instances.id = ready.instance_id
         WHERE ready.available_at_ms <= ? AND instances.paused = 0
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table("claimed_messages")} claimed
             WHERE claimed.instance_id = ready.instance_id AND claimed.sequence < ready.sequence
           )
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table("ready_messages")} earlier
             WHERE earlier.instance_id = ready.instance_id AND earlier.sequence < ready.sequence
           )
           AND (instances.activation_owner_id IS NULL OR instances.activation_expires_at_ms <= ?)
         ORDER BY ready.available_at_ms, ready.sequence
         LIMIT 1`,
        [now, now],
      )
      if (!candidate) return undefined

      const token = randomUUID()
      const lease = await connection.run(
        `UPDATE ${this.table("instances")}
         SET activation_owner_id = ?, activation_token = ?, activation_generation = activation_generation + 1,
           activation_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND (activation_owner_id IS NULL OR activation_expires_at_ms <= ?)`,
        [
          processId,
          token,
          now + this.settings.leaseDurationMilliseconds,
          now,
          candidate.instance_id,
          now,
        ],
      )
      if (lease.changes !== 1) return undefined

      const instance = await connection.get<InstanceRow>(
        `SELECT * FROM ${this.table("instances")} WHERE id = ?`,
        [candidate.instance_id],
      )
      const message = await connection.get<MessageRow>(
        `SELECT * FROM ${this.table("messages")} WHERE id = ?`,
        [candidate.message_id],
      )
      if (!instance || !message) return undefined

      const removed = await connection.run(
        `DELETE FROM ${this.table("ready_messages")} WHERE message_id = ?`,
        [message.id],
      )
      if (removed.changes !== 1) return undefined
      await connection.run(
        `INSERT INTO ${this.table("claimed_messages")}
         (message_id, instance_id, sequence, process_id, activation_token, activation_generation, claimed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          instance.id,
          message.sequence,
          processId,
          token,
          instance.activation_generation,
          now,
        ],
      )
      await connection.run(
        `UPDATE ${this.table("messages")} SET attempt_count = attempt_count + 1, updated_at_ms = ? WHERE id = ?`,
        [now, message.id],
      )
      message.attempt_count = Number(message.attempt_count) + 1
      return {
        instance,
        message,
        processId,
        activationToken: token,
        activationGeneration: BigInt(instance.activation_generation),
        nowMilliseconds: now,
      }
    })
  }

  async renewTurn(turn: ClaimedTurn): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const renewed = await connection.run(
        `UPDATE ${this.table("instances")}
         SET activation_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND activation_owner_id = ? AND activation_token = ?
           AND activation_generation = ? AND activation_expires_at_ms > ?
           AND EXISTS (
             SELECT 1 FROM ${this.table("claimed_messages")} claimed
             WHERE claimed.message_id = ? AND claimed.instance_id = ?
               AND claimed.process_id = ? AND claimed.activation_token = ?
               AND claimed.activation_generation = ?
           )`,
        [
          now + this.settings.leaseDurationMilliseconds,
          now,
          turn.instance.id,
          turn.processId,
          turn.activationToken,
          turn.activationGeneration,
          now,
          turn.message.id,
          turn.instance.id,
          turn.processId,
          turn.activationToken,
          turn.activationGeneration,
        ],
      )
      if (renewed.changes !== 1) throw new LostActivation("activation lease could not be renewed")
      await connection.run(
        `UPDATE ${this.table("processes")} SET heartbeat_at_ms = ? WHERE id = ?`,
        [now, turn.processId],
      )
    })
  }

  async complete(
    turn: ClaimedTurn,
    input: {
      state: Record<string, JsonValue>
      stateVersion: number
      result: JsonValue
      changedObservables: Record<string, JsonValue>
      intents: ActorIntents
      executeCommitAction(
        intent: ActorIntents["commitActions"][number],
        connection: DatabaseConnection,
      ): Promise<void>
    },
  ): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await this.assertFence(connection, turn)
      for (const intent of input.intents.commitActions) {
        await input.executeCommitAction(intent, connection)
      }

      await connection.run(
        `UPDATE ${this.table("instances")} SET state = ?, state_version = ?, state_revision = ?,
         activation_owner_id = NULL, activation_token = NULL, activation_expires_at_ms = NULL,
         updated_at_ms = ? WHERE id = ?`,
        [
          JSON.stringify(input.state),
          input.stateVersion,
          turn.message.sequence,
          now,
          turn.instance.id,
        ],
      )
      await connection.run(
        `UPDATE ${this.table("messages")} SET result = ?, completed_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
        [JSON.stringify(input.result), now, now, turn.message.id],
      )
      await connection.run(`DELETE FROM ${this.table("claimed_messages")} WHERE message_id = ?`, [
        turn.message.id,
      ])

      for (const effect of input.intents.effects) {
        await connection.run(
          `INSERT INTO ${this.table("effects")}
           (id, message_id, instance_id, name, arguments, success_operation, failure_operation,
            status, max_attempts, available_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [
            randomUUID(),
            turn.message.id,
            turn.instance.id,
            effect.name,
            JSON.stringify(effect.arguments),
            effect.successOperation ?? null,
            effect.failureOperation ?? null,
            this.settings.maxAttempts,
            now,
          ],
        )
      }

      for (const reminder of input.intents.reminders) {
        await connection.run(
          `INSERT INTO ${this.table("reminders")}
           (id, instance_id, operation, run_at_ms, arguments, interval_ms, missed_policy, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')
           ON CONFLICT(instance_id, operation) DO UPDATE SET run_at_ms = excluded.run_at_ms,
             arguments = excluded.arguments, interval_ms = excluded.interval_ms,
             missed_policy = excluded.missed_policy, status = 'scheduled', error = NULL`,
          [
            randomUUID(),
            turn.instance.id,
            reminder.operation,
            reminder.atMilliseconds,
            JSON.stringify(reminder.arguments),
            reminder.intervalMilliseconds ?? null,
            reminder.missedPolicy,
          ],
        )
      }

      for (const outbound of input.intents.outboundMessages) {
        await this.enqueueInTransaction(connection, {
          actorType: outbound.actorType,
          actorId: outbound.actorId,
          operation: outbound.operation,
          deliveryMode: "internal",
          arguments: outbound.arguments,
          ...(outbound.availableAtMilliseconds === undefined
            ? {}
            : { availableAtMilliseconds: outbound.availableAtMilliseconds }),
          ...(outbound.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: outbound.idempotencyKey }),
        })
      }

      if (Object.keys(input.changedObservables).length > 0) {
        await connection.run(
          `INSERT INTO ${this.table("broadcasts")}
           (id, message_id, instance_id, actor_type, actor_id, state_revision, observables,
            status, available_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [
            randomUUID(),
            turn.message.id,
            turn.instance.id,
            turn.message.actor_type,
            turn.message.actor_id,
            turn.message.sequence,
            JSON.stringify(input.changedObservables),
            now,
          ],
        )
      }
    })
  }

  async reject(
    turn: ClaimedTurn,
    rejection: { code: string; message: string; details: unknown },
  ): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await this.assertFence(connection, turn)
      await connection.run(
        `UPDATE ${this.table("messages")} SET rejection = ?, completed_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
        [JSON.stringify(rejection), now, now, turn.message.id],
      )
      await this.releaseClaim({ connection, turn, now })
    })
  }

  async fail(turn: ClaimedTurn, options: { error: unknown; retryable: boolean }): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await this.assertFence(connection, turn)
      const errorRecord = safeError(options.error)
      const exhausted =
        !options.retryable ||
        Number(turn.message.attempt_count) >= Number(turn.message.max_attempts)
      if (exhausted) {
        await connection.run(
          `UPDATE ${this.table("messages")} SET error = ?, completed_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
          [JSON.stringify(errorRecord), now, now, turn.message.id],
        )
        await connection.run(
          `INSERT INTO ${this.table("dead_letters")}
           (id, message_id, instance_id, attempts, error, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            turn.message.id,
            turn.instance.id,
            turn.message.attempt_count,
            JSON.stringify(errorRecord),
            now,
          ],
        )
        await this.releaseClaim({ connection, turn, now })
        return
      }

      const availableAt =
        now + this.settings.retryDelayMilliseconds(Number(turn.message.attempt_count))
      await connection.run(
        `UPDATE ${this.table("messages")} SET error = ?, updated_at_ms = ? WHERE id = ?`,
        [JSON.stringify(errorRecord), now, turn.message.id],
      )
      await connection.run(`DELETE FROM ${this.table("claimed_messages")} WHERE message_id = ?`, [
        turn.message.id,
      ])
      await connection.run(
        `INSERT INTO ${this.table("ready_messages")}(message_id, instance_id, sequence, available_at_ms)
         VALUES (?, ?, ?, ?)`,
        [turn.message.id, turn.instance.id, turn.message.sequence, availableAt],
      )
      await connection.run(
        `UPDATE ${this.table("instances")} SET activation_owner_id = NULL, activation_token = NULL,
         activation_expires_at_ms = NULL, updated_at_ms = ? WHERE id = ?`,
        [now, turn.instance.id],
      )
    })
  }

  async findMessage(id: string): Promise<MessageRow | undefined> {
    return this.settings.database.connection((connection) =>
      connection.get<MessageRow>(`SELECT * FROM ${this.table("messages")} WHERE id = ?`, [id]),
    )
  }

  async messageStatus(
    id: string,
  ): Promise<"ready" | "claimed" | "completed" | "rejected" | "dead" | "unknown"> {
    return this.settings.database.connection(async (connection) => {
      const message = await connection.get<MessageRow>(
        `SELECT * FROM ${this.table("messages")} WHERE id = ?`,
        [id],
      )
      if (!message) return "unknown"
      if (message.rejection !== null) return "rejected"
      if (message.completed_at_ms !== null) {
        const dead = await connection.get<{ found: number | bigint }>(
          `SELECT 1 AS found FROM ${this.table("dead_letters")} WHERE message_id = ?`,
          [id],
        )
        return dead ? "dead" : "completed"
      }
      const claimed = await connection.get<{ found: number | bigint }>(
        `SELECT 1 AS found FROM ${this.table("claimed_messages")} WHERE message_id = ?`,
        [id],
      )
      if (claimed) return "claimed"
      const ready = await connection.get<{ found: number | bigint }>(
        `SELECT 1 AS found FROM ${this.table("ready_messages")} WHERE message_id = ?`,
        [id],
      )
      return ready ? "ready" : "unknown"
    })
  }

  async listDeadLetters(): Promise<DeadLetterRow[]> {
    return this.settings.database.connection((connection) =>
      connection.all<DeadLetterRow>(
        `SELECT dead_letters.*, messages.actor_type, messages.actor_id, messages.operation,
          messages.delivery_mode, messages.arguments
         FROM ${this.table("dead_letters")} dead_letters
         JOIN ${this.table("messages")} messages ON messages.id = dead_letters.message_id
         ORDER BY dead_letters.created_at_ms DESC, dead_letters.id DESC`,
      ),
    )
  }

  async findDeadLetter(id: string): Promise<DeadLetterRow | undefined> {
    return this.settings.database.connection((connection) =>
      this.findDeadLetterInConnection(connection, id),
    )
  }

  async retryDeadLetter(options: {
    id: string
    initialState: JsonObject
    stateVersion: number
  }): Promise<MessageRow> {
    return this.settings.database.transaction(async (connection) => {
      const deadLetter = await this.findDeadLetterInConnection(connection, options.id)
      if (!deadLetter) throw new UnknownDeadLetter(`unknown dead letter ${options.id}`)
      if (deadLetter.retried_message_id) {
        const retriedMessage = await connection.get<MessageRow>(
          `SELECT * FROM ${this.table("messages")} WHERE id = ?`,
          [deadLetter.retried_message_id],
        )
        if (!retriedMessage) {
          throw new Error(`retried message ${deadLetter.retried_message_id} is missing`)
        }
        return retriedMessage
      }

      const retriedMessage = await this.enqueueInTransaction(connection, {
        actorType: deadLetter.actor_type,
        actorId: deadLetter.actor_id,
        operation: deadLetter.operation,
        deliveryMode: deadLetter.delivery_mode,
        arguments: jsonObject(JSON.parse(deadLetter.arguments)),
        initialState: options.initialState,
        stateVersion: options.stateVersion,
        idempotencyKey: `dead-letter:${deadLetter.id}`,
      })
      await connection.run(
        `UPDATE ${this.table("dead_letters")} SET retried_message_id = ? WHERE id = ?`,
        [retriedMessage.id, deadLetter.id],
      )
      return retriedMessage
    })
  }

  async findInstanceByIdentity(
    actorType: string,
    actorId: string,
  ): Promise<InstanceRow | undefined> {
    return this.settings.database.connection((connection) =>
      this.findInstance({ connection, actorType, actorId }),
    )
  }

  async activeInstances(options: {
    actorType?: string
    cursor?: string
    limit: number
  }): Promise<InstanceRow[]> {
    const conditions = ["paused = 0"]
    const parameters: unknown[] = []
    if (options.actorType !== undefined) {
      conditions.push("actor_type = ?")
      parameters.push(options.actorType)
    }
    if (options.cursor !== undefined) {
      conditions.push("id > ?")
      parameters.push(options.cursor)
    }
    parameters.push(options.limit + 1)
    return this.settings.database.connection((connection) =>
      connection.all<InstanceRow>(
        `SELECT * FROM ${this.table("instances")}
         WHERE ${conditions.join(" AND ")}
         ORDER BY id LIMIT ?`,
        parameters,
      ),
    )
  }

  async instancesWithoutPendingWork(options: {
    actorType?: string
    cursor?: string
    limit: number
    quietForMilliseconds: number
  }): Promise<InstanceRow[]> {
    return this.settings.database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      const conditions = [
        "instances.paused = 0",
        "instances.updated_at_ms <= ?",
        `NOT EXISTS (
          SELECT 1 FROM ${this.table("ready_messages")} ready
          WHERE ready.instance_id = instances.id
        )`,
        `NOT EXISTS (
          SELECT 1 FROM ${this.table("claimed_messages")} claimed
          WHERE claimed.instance_id = instances.id
        )`,
        `NOT EXISTS (
          SELECT 1 FROM ${this.table("reminders")} reminders
          WHERE reminders.instance_id = instances.id AND reminders.status = 'scheduled'
        )`,
      ]
      const parameters: unknown[] = [now - options.quietForMilliseconds]
      if (options.actorType !== undefined) {
        conditions.push("instances.actor_type = ?")
        parameters.push(options.actorType)
      }
      if (options.cursor !== undefined) {
        conditions.push("instances.id > ?")
        parameters.push(options.cursor)
      }
      parameters.push(options.limit + 1)
      return connection.all<InstanceRow>(
        `SELECT instances.* FROM ${this.table("instances")} instances
         WHERE ${conditions.join(" AND ")}
         ORDER BY instances.id LIMIT ?`,
        parameters,
      )
    })
  }

  async instanceStatesFor(options: {
    actorType: string
    actorIds: readonly string[]
  }): Promise<InstanceRow[]> {
    if (options.actorIds.length === 0) return []
    return this.settings.database.connection((connection) =>
      connection.all<InstanceRow>(
        `SELECT * FROM ${this.table("instances")}
         WHERE actor_type = ?
           AND actor_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
        [options.actorType, JSON.stringify(options.actorIds)],
      ),
    )
  }

  async orphanedInstances(options: {
    actorType: string
    ownerIds: readonly string[]
    cursor?: string
    limit: number
  }): Promise<InstanceRow[]> {
    const conditions = [
      "actor_type = ?",
      "actor_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
    ]
    const parameters: unknown[] = [options.actorType, JSON.stringify(options.ownerIds)]
    if (options.cursor !== undefined) {
      conditions.push("id > ?")
      parameters.push(options.cursor)
    }
    parameters.push(options.limit + 1)
    return this.settings.database.connection((connection) =>
      connection.all<InstanceRow>(
        `SELECT * FROM ${this.table("instances")}
         WHERE ${conditions.join(" AND ")}
         ORDER BY id LIMIT ?`,
        parameters,
      ),
    )
  }

  private async findDeadLetterInConnection(
    connection: DatabaseConnection,
    id: string,
  ): Promise<DeadLetterRow | undefined> {
    return connection.get<DeadLetterRow>(
      `SELECT dead_letters.*, messages.actor_type, messages.actor_id, messages.operation,
        messages.delivery_mode, messages.arguments
       FROM ${this.table("dead_letters")} dead_letters
       JOIN ${this.table("messages")} messages ON messages.id = dead_letters.message_id
       WHERE dead_letters.id = ?`,
      [id],
    )
  }

  async destroy(actorType: string, actorId: string): Promise<boolean> {
    return this.settings.database.transaction(async (connection) => {
      const result = await connection.run(
        `DELETE FROM ${this.table("instances")} WHERE actor_type = ? AND actor_id = ?`,
        [actorType, actorId],
      )
      return result.changes === 1
    })
  }

  async claimEffect(processId: string): Promise<EffectRow | undefined> {
    return this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const staleAt = now - this.settings.processAliveThresholdMilliseconds
      await connection.run(
        `UPDATE ${this.table("effects")} SET status = 'pending', claimed_by = NULL
         WHERE status = 'processing' AND (
           claimed_by IS NULL OR NOT EXISTS (
             SELECT 1 FROM ${this.table("processes")} processes
             WHERE processes.id = ${this.table("effects")}.claimed_by
               AND processes.shutdown_state = 'running' AND processes.heartbeat_at_ms > ?
           )
         )`,
        [staleAt],
      )
      const effect = await connection.get<EffectRow>(
        `SELECT effects.*, instances.actor_type, instances.actor_id
         FROM ${this.table("effects")} effects
         JOIN ${this.table("instances")} instances ON instances.id = effects.instance_id
         WHERE effects.status = 'pending' AND effects.available_at_ms <= ?
         ORDER BY effects.available_at_ms, effects.id
         LIMIT 1`,
        [now],
      )
      if (!effect) return undefined
      const claimed = await connection.run(
        `UPDATE ${this.table("effects")}
         SET status = 'processing', claimed_by = ?, attempt_count = attempt_count + 1
         WHERE id = ? AND status = 'pending'`,
        [processId, effect.id],
      )
      if (claimed.changes !== 1) return undefined
      effect.status = "processing"
      effect.claimed_by = processId
      effect.attempt_count = Number(effect.attempt_count) + 1
      return effect
    })
  }

  async completeEffect(effect: EffectRow, result: JsonValue): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const updated = await connection.run(
        `UPDATE ${this.table("effects")}
         SET status = 'completed', result = ?, error = NULL, claimed_by = NULL
         WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        [JSON.stringify(result), effect.id, effect.claimed_by],
      )
      if (updated.changes !== 1) throw new LostActivation("effect claim no longer matches")
      if (!effect.success_operation) return
      await this.enqueueInTransaction(connection, {
        actorType: effect.actor_type,
        actorId: effect.actor_id,
        operation: effect.success_operation,
        deliveryMode: "internal",
        arguments: jsonObject({ effectId: effect.id, result }),
        idempotencyKey: `effect:${effect.id}:success`,
      })
      void now
    })
  }

  async failEffect(options: {
    effect: EffectRow
    error: unknown
    retryable: boolean
  }): Promise<void> {
    const { effect, error, retryable } = options
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const errorRecord = safeError(error)
      const exhausted = !retryable || Number(effect.attempt_count) >= Number(effect.max_attempts)
      if (!exhausted) {
        const availableAt = now + this.settings.retryDelayMilliseconds(Number(effect.attempt_count))
        const updated = await connection.run(
          `UPDATE ${this.table("effects")}
           SET status = 'pending', error = ?, available_at_ms = ?, claimed_by = NULL
           WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
          [JSON.stringify(errorRecord), availableAt, effect.id, effect.claimed_by],
        )
        if (updated.changes !== 1) throw new LostActivation("effect claim no longer matches")
        return
      }

      const updated = await connection.run(
        `UPDATE ${this.table("effects")}
         SET status = 'dead', error = ?, claimed_by = NULL
         WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        [JSON.stringify(errorRecord), effect.id, effect.claimed_by],
      )
      if (updated.changes !== 1) throw new LostActivation("effect claim no longer matches")
      if (!effect.failure_operation) return
      await this.enqueueInTransaction(connection, {
        actorType: effect.actor_type,
        actorId: effect.actor_id,
        operation: effect.failure_operation,
        deliveryMode: "internal",
        arguments: jsonObject({ effectId: effect.id, error: errorRecord }),
        idempotencyKey: `effect:${effect.id}:failure`,
      })
    })
  }

  async claimReminder(processId: string): Promise<ReminderRow | undefined> {
    return this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const staleAt = now - this.settings.processAliveThresholdMilliseconds
      await connection.run(
        `UPDATE ${this.table("reminders")} SET claimed_by = NULL, claimed_at_ms = NULL
         WHERE claimed_by IS NOT NULL AND (
           claimed_at_ms <= ? OR NOT EXISTS (
             SELECT 1 FROM ${this.table("processes")} processes
             WHERE processes.id = ${this.table("reminders")}.claimed_by
               AND processes.shutdown_state = 'running' AND processes.heartbeat_at_ms > ?
           )
         )`,
        [staleAt, staleAt],
      )
      const reminder = await connection.get<ReminderRow>(
        `SELECT reminders.*, instances.actor_type, instances.actor_id
         FROM ${this.table("reminders")} reminders
         JOIN ${this.table("instances")} instances ON instances.id = reminders.instance_id
         WHERE reminders.status = 'scheduled' AND reminders.run_at_ms <= ?
           AND reminders.claimed_by IS NULL
         ORDER BY reminders.run_at_ms, reminders.id
         LIMIT 1`,
        [now],
      )
      if (!reminder) return undefined
      const claimed = await connection.run(
        `UPDATE ${this.table("reminders")} SET claimed_by = ?, claimed_at_ms = ?
         WHERE id = ? AND status = 'scheduled' AND claimed_by IS NULL`,
        [processId, now, reminder.id],
      )
      if (claimed.changes !== 1) return undefined
      reminder.claimed_by = processId
      reminder.claimed_at_ms = now
      return reminder
    })
  }

  async enqueueReminder(reminder: ReminderRow): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const claimed = await connection.get<ReminderRow>(
        `SELECT reminders.*, instances.actor_type, instances.actor_id
         FROM ${this.table("reminders")} reminders
         JOIN ${this.table("instances")} instances ON instances.id = reminders.instance_id
         WHERE reminders.id = ? AND reminders.status = 'scheduled' AND reminders.claimed_by = ?`,
        [reminder.id, reminder.claimed_by],
      )
      if (!claimed) throw new LostActivation("reminder claim no longer matches")
      await this.enqueueInTransaction(connection, {
        actorType: claimed.actor_type,
        actorId: claimed.actor_id,
        operation: claimed.operation,
        deliveryMode: "internal",
        arguments: jsonObject(JSON.parse(claimed.arguments)),
        idempotencyKey: `reminder:${claimed.id}:${claimed.occurrence}`,
      })

      const interval = claimed.interval_ms === null ? undefined : Number(claimed.interval_ms)
      const nextRun =
        interval === undefined
          ? Number(claimed.run_at_ms)
          : nextReminderRun({
              previousRun: Number(claimed.run_at_ms),
              interval,
              missedPolicy: claimed.missed_policy,
              now,
            })
      await connection.run(
        `UPDATE ${this.table("reminders")}
         SET status = ?, occurrence = occurrence + 1, run_at_ms = ?, claimed_by = NULL, claimed_at_ms = NULL
         WHERE id = ? AND claimed_by = ?`,
        [
          interval === undefined ? "completed" : "scheduled",
          nextRun,
          claimed.id,
          claimed.claimed_by,
        ],
      )
    })
  }

  async releaseReminder(reminder: ReminderRow): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      await connection.run(
        `UPDATE ${this.table("reminders")} SET claimed_by = NULL, claimed_at_ms = NULL
         WHERE id = ? AND claimed_by = ?`,
        [reminder.id, reminder.claimed_by],
      )
    })
  }

  async failReminder(reminder: ReminderRow, error: unknown): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const updated = await connection.run(
        `UPDATE ${this.table("reminders")}
         SET status = 'paused', claimed_by = NULL, claimed_at_ms = NULL, error = ?
         WHERE id = ? AND status = 'scheduled' AND claimed_by = ?`,
        [JSON.stringify(safeError(error)), reminder.id, reminder.claimed_by],
      )
      if (updated.changes !== 1) throw new LostActivation("reminder claim no longer matches")
    })
  }

  async claimBroadcast(processId: string): Promise<BroadcastRow | undefined> {
    return this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const staleAt = now - this.settings.processAliveThresholdMilliseconds
      await connection.run(
        `UPDATE ${this.table("broadcasts")} SET status = 'pending', claimed_by = NULL
         WHERE status = 'processing' AND (
           claimed_by IS NULL OR NOT EXISTS (
             SELECT 1 FROM ${this.table("processes")} processes
             WHERE processes.id = ${this.table("broadcasts")}.claimed_by
               AND processes.shutdown_state = 'running' AND processes.heartbeat_at_ms > ?
           )
         )`,
        [staleAt],
      )
      const broadcast = await connection.get<BroadcastRow>(
        `SELECT * FROM ${this.table("broadcasts")}
         WHERE status = 'pending' AND available_at_ms <= ?
         ORDER BY available_at_ms, id
         LIMIT 1`,
        [now],
      )
      if (!broadcast) return undefined
      const claimed = await connection.run(
        `UPDATE ${this.table("broadcasts")}
         SET status = 'processing', claimed_by = ?, attempt_count = attempt_count + 1
         WHERE id = ? AND status = 'pending'`,
        [processId, broadcast.id],
      )
      if (claimed.changes !== 1) return undefined
      broadcast.status = "processing"
      broadcast.claimed_by = processId
      broadcast.attempt_count = Number(broadcast.attempt_count) + 1
      return broadcast
    })
  }

  async completeBroadcast(broadcast: BroadcastRow): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const updated = await connection.run(
        `UPDATE ${this.table("broadcasts")}
         SET status = 'delivered', claimed_by = NULL, error = NULL
         WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        [broadcast.id, broadcast.claimed_by],
      )
      if (updated.changes !== 1) throw new LostActivation("broadcast claim no longer matches")
    })
  }

  async failBroadcast(broadcast: BroadcastRow, error: unknown): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const exhausted = Number(broadcast.attempt_count) >= this.settings.maxAttempts
      const status = exhausted ? "dead" : "pending"
      const availableAt = exhausted
        ? Number(broadcast.available_at_ms)
        : now + this.settings.retryDelayMilliseconds(Number(broadcast.attempt_count))
      const updated = await connection.run(
        `UPDATE ${this.table("broadcasts")}
         SET status = ?, error = ?, available_at_ms = ?, claimed_by = NULL
         WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        [status, JSON.stringify(safeError(error)), availableAt, broadcast.id, broadcast.claimed_by],
      )
      if (updated.changes !== 1) throw new LostActivation("broadcast claim no longer matches")
    })
  }

  private findInstance(options: {
    connection: DatabaseConnection
    actorType: string
    actorId: string
  }): Promise<InstanceRow | undefined> {
    const { connection, actorType, actorId } = options
    return connection.get<InstanceRow>(
      `SELECT * FROM ${this.table("instances")} WHERE actor_type = ? AND actor_id = ?`,
      [actorType, actorId],
    )
  }

  private async recoverExpiredClaims(connection: DatabaseConnection, now: number): Promise<void> {
    const expired = await connection.all<{
      message_id: string
      instance_id: string
      sequence: number | bigint
    }>(
      `SELECT claimed.message_id, claimed.instance_id, claimed.sequence
       FROM ${this.table("claimed_messages")} claimed
       JOIN ${this.table("instances")} instances ON instances.id = claimed.instance_id
       WHERE instances.activation_expires_at_ms <= ?`,
      [now],
    )
    for (const claim of expired) {
      await connection.run(`DELETE FROM ${this.table("claimed_messages")} WHERE message_id = ?`, [
        claim.message_id,
      ])
      await connection.run(
        `INSERT INTO ${this.table("ready_messages")}(message_id, instance_id, sequence, available_at_ms)
         VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
        [claim.message_id, claim.instance_id, claim.sequence, now],
      )
      await connection.run(
        `UPDATE ${this.table("instances")}
         SET activation_owner_id = NULL, activation_token = NULL, activation_expires_at_ms = NULL,
           updated_at_ms = ? WHERE id = ?`,
        [now, claim.instance_id],
      )
    }
  }

  private async assertFence(connection: DatabaseConnection, turn: ClaimedTurn): Promise<number> {
    const now = await connection.nowMilliseconds()
    const fence = await connection.get<{ found: number | bigint }>(
      `SELECT 1 AS found FROM ${this.table("instances")} instances
       JOIN ${this.table("claimed_messages")} claimed ON claimed.instance_id = instances.id
       WHERE instances.id = ? AND instances.activation_owner_id = ? AND instances.activation_token = ?
         AND instances.activation_generation = ? AND instances.activation_expires_at_ms > ?
         AND claimed.message_id = ? AND claimed.process_id = ? AND claimed.activation_token = ?
         AND claimed.activation_generation = ?`,
      [
        turn.instance.id,
        turn.processId,
        turn.activationToken,
        turn.activationGeneration,
        now,
        turn.message.id,
        turn.processId,
        turn.activationToken,
        turn.activationGeneration,
      ],
    )
    if (!fence) throw new LostActivation("activation fence no longer matches")
    return now
  }

  private async releaseClaim(options: {
    connection: DatabaseConnection
    turn: ClaimedTurn
    now: number
  }): Promise<void> {
    const { connection, turn, now } = options
    await connection.run(`DELETE FROM ${this.table("claimed_messages")} WHERE message_id = ?`, [
      turn.message.id,
    ])
    await connection.run(
      `UPDATE ${this.table("instances")} SET activation_owner_id = NULL, activation_token = NULL,
       activation_expires_at_ms = NULL, updated_at_ms = ? WHERE id = ?`,
      [now, turn.instance.id],
    )
  }
}

function nextReminderRun(options: {
  previousRun: number
  interval: number
  missedPolicy: "latest" | "all"
  now: number
}): number {
  const { previousRun, interval, missedPolicy, now } = options
  if (missedPolicy === "all") return previousRun + interval
  if (previousRun > now) return previousRun
  return previousRun + (Math.floor((now - previousRun) / interval) + 1) * interval
}

function safeError(error: unknown): Record<string, JsonValue> {
  if (error instanceof Error) {
    return jsonObject({ name: error.name, message: error.message })
  }
  return jsonObject({ name: "Error", message: String(normalizeJson(error)) })
}

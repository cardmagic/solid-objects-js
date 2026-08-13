import { randomUUID } from "node:crypto"
import {
  ActorDestroyed,
  IdempotencyConflict,
  LostActivation,
  MailboxFull,
  ReminderNotPaused,
  UnknownDeadLetter,
  UnknownReminder,
} from "./errors.js"
import type { ActorIntents } from "./actor.js"
import type { RuntimeSettings } from "./configuration.js"
import type { Database, DatabaseConnection } from "./database/types.js"
import type {
  BroadcastRow,
  ActivationLease,
  ClaimedTurn,
  DeadLetterRow,
  EffectRow,
  EnqueueInput,
  InstanceRow,
  MessageRow,
  ProcessRow,
  ReminderRow,
} from "./records.js"
import { jsonObject, normalizeJson } from "./serialization.js"
import type { RetentionTarget } from "./retention.js"
import type { JsonObject, JsonValue } from "./types.js"

export interface SyncDiagnosticsRecord {
  message: MessageRow
  instance: InstanceRow
  process: ProcessRow | undefined
  status: "ready" | "claimed" | "completed" | "rejected" | "dead" | "unknown"
  readyAvailableAtMilliseconds: number | undefined
  blocker:
    | (MessageRow & {
        membership_status: "ready" | "claimed"
      })
    | undefined
  nowMilliseconds: number
}

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

  async listProcesses(): Promise<{ rows: ProcessRow[]; staleAtMilliseconds: number }> {
    return this.settings.database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      const rows = await connection.all<ProcessRow>(
        `SELECT * FROM ${this.table("processes")} ORDER BY kind, started_at_ms, id`,
      )
      return {
        rows,
        staleAtMilliseconds: now - this.settings.processAliveThresholdMilliseconds,
      }
    })
  }

  async cleanupStaleProcesses(): Promise<number> {
    return this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const staleAt = now - this.settings.processAliveThresholdMilliseconds
      const processes = await connection.all<{ id: string }>(
        `SELECT id FROM ${this.table("processes")}
         WHERE shutdown_state = 'running' AND heartbeat_at_ms <= ?
         ORDER BY id`,
        [staleAt],
      )
      for (const process of processes) {
        const claims = await connection.all<{
          message_id: string
          instance_id: string
          sequence: number | bigint
        }>(
          `SELECT message_id, instance_id, sequence
           FROM ${this.table("claimed_messages")} WHERE process_id = ?`,
          [process.id],
        )
        for (const claim of claims) {
          await connection.run(
            `DELETE FROM ${this.table("claimed_messages")} WHERE message_id = ?`,
            [claim.message_id],
          )
          await connection.run(
            `INSERT INTO ${this.table("ready_messages")}
             (message_id, instance_id, sequence, available_at_ms)
             VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
            [claim.message_id, claim.instance_id, claim.sequence, now],
          )
        }
        await connection.run(
          `UPDATE ${this.table("instances")}
           SET activation_owner_id = NULL, activation_token = NULL,
             activation_expires_at_ms = NULL, updated_at_ms = ?
           WHERE activation_owner_id = ?`,
          [now, process.id],
        )
        await connection.run(
          `UPDATE ${this.table("effects")} SET status = 'pending', claimed_by = NULL
           WHERE status = 'processing' AND claimed_by = ?`,
          [process.id],
        )
        await connection.run(
          `UPDATE ${this.table("reminders")} SET claimed_by = NULL, claimed_at_ms = NULL
           WHERE claimed_by = ?`,
          [process.id],
        )
        await connection.run(
          `UPDATE ${this.table("broadcasts")} SET status = 'pending', claimed_by = NULL
           WHERE status = 'processing' AND claimed_by = ?`,
          [process.id],
        )
        await connection.run(
          `UPDATE ${this.table("processes")}
           SET shutdown_state = 'stopped', stopped_at_ms = ?, heartbeat_at_ms = ?
           WHERE id = ? AND shutdown_state = 'running'`,
          [now, now, process.id],
        )
      }
      return processes.length
    })
  }

  async enqueue(input: EnqueueInput): Promise<MessageRow> {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        return await this.settings.database.transaction(async (connection) =>
          this.enqueueInTransaction(connection, input),
        )
      } catch (error) {
        if (!retryableMySQLDeadlock({ database: this.settings.database, error, attempt })) {
          throw error
        }
        await transactionRetryBackoff(attempt)
      }
    }
    throw new Error("enqueue retries exhausted")
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
      ...(this.settings.database.family === "postgresql" ? { lock: "update" } : {}),
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
    }
    if (this.settings.database.family === "mysql" || !instance) {
      instance = await this.findInstance({
        connection,
        actorType: input.actorType,
        actorId: input.actorId,
        ...(this.settings.database.family === "sqlite" ? {} : { lock: "update" }),
      })
    }
    if (!instance) throw new ActorDestroyed("actor disappeared during enqueue")

    if (input.idempotencyKey !== undefined) {
      const existing = await connection.get<MessageRow>(
        `SELECT * FROM ${this.table("messages")} WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
        [input.actorType, input.actorId, input.idempotencyKey],
      )
      if (existing) {
        if (
          existing.operation !== input.operation ||
          existing.delivery_mode !== input.deliveryMode ||
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
      ) AS live_messages`,
      [instance.id, instance.id],
    )
    if (Number(live?.count ?? 0) >= this.settings.maxMailboxLength) {
      throw new MailboxFull(
        `mailbox is full for ${input.actorType}(${JSON.stringify(input.actorId)})`,
      )
    }

    const sequence = BigInt(instance.next_message_sequence)
    const messageId = randomUUID()
    const requestId = randomUUID()
    await connection.run(
      `UPDATE ${this.table("instances")} SET next_message_sequence = next_message_sequence + 1,
       updated_at_ms = ? WHERE id = ?`,
      [now, instance.id],
    )
    await connection.run(
      `INSERT INTO ${this.table("messages")}
       (id, request_id, idempotency_key, instance_id, actor_type, actor_id, sequence, operation,
        delivery_mode, arguments, max_attempts, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        requestId,
        input.idempotencyKey ?? null,
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

  async claim(
    processId: string,
    options: { instanceId?: string; activation?: ActivationLease } = {},
  ): Promise<ClaimedTurn | undefined> {
    return this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      await this.recoverExpiredClaims(connection, now)
      const instanceCondition =
        options.activation !== undefined || options.instanceId !== undefined
          ? "AND ready.instance_id = ?"
          : ""
      const leaseCondition = options.activation
        ? `AND instances.activation_owner_id = ? AND instances.activation_token = ?
           AND instances.activation_generation = ? AND instances.activation_expires_at_ms > ?`
        : "AND (instances.activation_owner_id IS NULL OR instances.activation_expires_at_ms <= ?)"
      const parameters: unknown[] = [now]
      if (options.activation) {
        parameters.push(
          options.activation.instanceId,
          options.activation.processId,
          options.activation.activationToken,
          options.activation.activationGeneration,
          now,
        )
      } else {
        if (options.instanceId !== undefined) parameters.push(options.instanceId)
        parameters.push(now)
      }
      const candidates = await connection.all<{ message_id: string; instance_id: string }>(
        `SELECT ready.message_id, ready.instance_id
         FROM ${this.table("ready_messages")} ready
         JOIN ${this.table("instances")} instances ON instances.id = ready.instance_id
         WHERE ready.available_at_ms <= ? AND instances.paused = 0
           ${instanceCondition}
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table("claimed_messages")} claimed
             WHERE claimed.instance_id = ready.instance_id AND claimed.sequence < ready.sequence
           )
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table("ready_messages")} earlier
             WHERE earlier.instance_id = ready.instance_id AND earlier.sequence < ready.sequence
           )
           ${leaseCondition}
         ORDER BY ready.available_at_ms, ready.sequence, ready.message_id
         LIMIT ?`,
        [
          ...parameters,
          options.activation || options.instanceId ? 1 : this.settings.claimScanLimit,
        ],
      )
      for (const candidate of candidates) {
        const token = options.activation?.activationToken ?? randomUUID()
        if (options.activation) {
          return this.claimCandidate({ connection, candidate, processId, token, now })
        }
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
        if (lease.changes !== 1) continue
        return this.claimCandidate({ connection, candidate, processId, token, now })
      }
      return undefined
    })
  }

  private async claimCandidate(options: {
    connection: DatabaseConnection
    candidate: { message_id: string; instance_id: string }
    processId: string
    token: string
    now: number
  }): Promise<ClaimedTurn | undefined> {
    const { connection, candidate, processId, token, now } = options
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

  async renewActivation(activation: ActivationLease): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const renewed = await connection.run(
        `UPDATE ${this.table("instances")}
         SET activation_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND activation_owner_id = ? AND activation_token = ?
           AND activation_generation = ? AND activation_expires_at_ms > ?`,
        [
          now + this.settings.leaseDurationMilliseconds,
          now,
          activation.instanceId,
          activation.processId,
          activation.activationToken,
          activation.activationGeneration,
          now,
        ],
      )
      if (renewed.changes !== 1) throw new LostActivation("activation lease could not be renewed")
      await connection.run(
        `UPDATE ${this.table("processes")} SET heartbeat_at_ms = ? WHERE id = ?`,
        [now, activation.processId],
      )
    })
  }

  async releaseActivation(activation: ActivationLease): Promise<void> {
    await this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      await connection.run(
        `UPDATE ${this.table("instances")}
         SET activation_owner_id = NULL, activation_token = NULL,
           activation_expires_at_ms = NULL, updated_at_ms = ?
         WHERE id = ? AND activation_owner_id = ? AND activation_token = ?
           AND activation_generation = ?`,
        [
          now,
          activation.instanceId,
          activation.processId,
          activation.activationToken,
          activation.activationGeneration,
        ],
      )
    })
  }

  async yieldReadyMessages(instanceId: string): Promise<number> {
    return this.settings.database.transaction(async (connection) => {
      const now = await connection.nowMilliseconds()
      const yielded = await connection.run(
        `UPDATE ${this.table("ready_messages")} SET available_at_ms = ?
         WHERE instance_id = ? AND available_at_ms <= ?`,
        [now, instanceId, now],
      )
      return yielded.changes
    })
  }

  async complete(
    turn: ClaimedTurn,
    input: {
      state: Record<string, JsonValue>
      stateVersion: number
      result: JsonValue
      broadcastObservables?: Record<string, JsonValue>
      intents: ActorIntents
      executeCommitAction(
        intent: ActorIntents["commitActions"][number],
        connection: DatabaseConnection,
      ): Promise<void>
    },
  ): Promise<{
    reminderReplacements: Array<{
      reminderId: string
      operation: string
      previousRunAtMilliseconds: number
      nextRunAtMilliseconds: number
    }>
  }> {
    const reminderReplacements: Array<{
      reminderId: string
      operation: string
      previousRunAtMilliseconds: number
      nextRunAtMilliseconds: number
    }> = []
    await this.settings.database.transaction(async (connection) => {
      const now = await this.assertFence(connection, turn)
      for (const intent of input.intents.commitActions) {
        await input.executeCommitAction(intent, connection)
      }

      await connection.run(
        `UPDATE ${this.table("instances")} SET state = ?, state_version = ?, state_revision = ?,
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
        const existing = await connection.get<{ id: string; run_at_ms: number | bigint }>(
          `SELECT id, run_at_ms FROM ${this.table("reminders")}
           WHERE instance_id = ? AND operation = ?`,
          [turn.instance.id, reminder.operation],
        )
        if (existing && Number(existing.run_at_ms) !== reminder.atMilliseconds) {
          reminderReplacements.push({
            reminderId: existing.id,
            operation: reminder.operation,
            previousRunAtMilliseconds: Number(existing.run_at_ms),
            nextRunAtMilliseconds: reminder.atMilliseconds,
          })
        }
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

      if (input.broadcastObservables !== undefined) {
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
            JSON.stringify(input.broadcastObservables),
            now,
          ],
        )
      }
    })
    return { reminderReplacements }
  }

  async listReminders(options: {
    actorType?: string
    status?: "scheduled" | "paused" | "completed"
    cursor?: string
    limit: number
  }): Promise<ReminderRow[]> {
    const conditions: string[] = []
    const parameters: unknown[] = []
    if (options.actorType !== undefined) {
      conditions.push("instances.actor_type = ?")
      parameters.push(options.actorType)
    }
    if (options.status !== undefined) {
      conditions.push("reminders.status = ?")
      parameters.push(options.status)
    }
    if (options.cursor !== undefined) {
      conditions.push("reminders.id > ?")
      parameters.push(options.cursor)
    }
    parameters.push(options.limit + 1)
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
    return this.settings.database.connection((connection) =>
      connection.all<ReminderRow>(
        `SELECT reminders.*, instances.actor_type, instances.actor_id
         FROM ${this.table("reminders")} reminders
         JOIN ${this.table("instances")} instances ON instances.id = reminders.instance_id
         ${where} ORDER BY reminders.id LIMIT ?`,
        parameters,
      ),
    )
  }

  async resumeReminder(options: {
    id: string
    runAtMilliseconds?: number
  }): Promise<{ reminder: ReminderRow; resumed: boolean }> {
    return this.settings.database.transaction(async (connection) => {
      const reminder = await this.findReminderInConnection(connection, options.id)
      if (!reminder) throw new UnknownReminder(`unknown reminder ${options.id}`)
      if (reminder.status === "completed") {
        throw new ReminderNotPaused(`completed reminder ${options.id} cannot be resumed`)
      }
      if (reminder.status === "scheduled") return { reminder, resumed: false }
      const runAt = options.runAtMilliseconds ?? (await connection.nowMilliseconds())
      await connection.run(
        `UPDATE ${this.table("reminders")}
         SET status = 'scheduled', run_at_ms = ?, error = NULL, claimed_by = NULL, claimed_at_ms = NULL
         WHERE id = ? AND status = 'paused'`,
        [runAt, options.id],
      )
      const resumed = await this.findReminderInConnection(connection, options.id)
      if (!resumed) throw new UnknownReminder(`unknown reminder ${options.id}`)
      return { reminder: resumed, resumed: true }
    })
  }

  private async findReminderInConnection(
    connection: DatabaseConnection,
    id: string,
  ): Promise<ReminderRow | undefined> {
    return connection.get<ReminderRow>(
      `SELECT reminders.*, instances.actor_type, instances.actor_id
       FROM ${this.table("reminders")} reminders
       JOIN ${this.table("instances")} instances ON instances.id = reminders.instance_id
       WHERE reminders.id = ?`,
      [id],
    )
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
      await this.releaseClaim({ connection, turn })
    })
  }

  async fail(
    turn: ClaimedTurn,
    options: { error: unknown; retryable: boolean },
  ): Promise<"dead" | "retrying"> {
    return this.settings.database.transaction(async (connection) => {
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
        await this.releaseClaim({ connection, turn })
        return "dead" as const
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
      return "retrying" as const
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

  async syncDiagnostics(messageId: string): Promise<SyncDiagnosticsRecord | undefined> {
    return this.settings.database.connection(async (connection) => {
      const message = await connection.get<MessageRow>(
        `SELECT * FROM ${this.table("messages")} WHERE id = ?`,
        [messageId],
      )
      if (!message) return undefined
      const instance = await connection.get<InstanceRow>(
        `SELECT * FROM ${this.table("instances")} WHERE id = ?`,
        [message.instance_id],
      )
      if (!instance) return undefined
      const process = instance.activation_owner_id
        ? await connection.get<ProcessRow>(
            `SELECT * FROM ${this.table("processes")} WHERE id = ?`,
            [instance.activation_owner_id],
          )
        : undefined
      const claimed = await connection.get<{ found: number | bigint }>(
        `SELECT 1 AS found FROM ${this.table("claimed_messages")} WHERE message_id = ?`,
        [message.id],
      )
      const ready = await connection.get<{ available_at_ms: number | bigint }>(
        `SELECT available_at_ms FROM ${this.table("ready_messages")} WHERE message_id = ?`,
        [message.id],
      )
      const dead =
        message.completed_at_ms === null
          ? undefined
          : await connection.get<{ found: number | bigint }>(
              `SELECT 1 AS found FROM ${this.table("dead_letters")} WHERE message_id = ?`,
              [message.id],
            )
      const blocker = await connection.get<MessageRow & { membership_status: "ready" | "claimed" }>(
        `SELECT messages.*,
           CASE WHEN claimed.message_id IS NOT NULL THEN 'claimed' ELSE 'ready' END AS membership_status
         FROM ${this.table("messages")} messages
         LEFT JOIN ${this.table("ready_messages")} ready ON ready.message_id = messages.id
         LEFT JOIN ${this.table("claimed_messages")} claimed ON claimed.message_id = messages.id
         WHERE messages.instance_id = ? AND messages.sequence < ?
           AND (ready.message_id IS NOT NULL OR claimed.message_id IS NOT NULL)
         ORDER BY messages.sequence LIMIT 1`,
        [message.instance_id, message.sequence],
      )
      const status = message.rejection
        ? "rejected"
        : message.completed_at_ms !== null
          ? dead
            ? "dead"
            : "completed"
          : claimed
            ? "claimed"
            : ready
              ? "ready"
              : "unknown"
      return {
        message,
        instance,
        process,
        status,
        readyAvailableAtMilliseconds:
          ready === undefined ? undefined : Number(ready.available_at_ms),
        blocker,
        nowMilliseconds: await connection.nowMilliseconds(),
      }
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
           AND actor_id IN (${parameterList(options.actorIds.length)})`,
        [options.actorType, ...options.actorIds],
      ),
    )
  }

  async orphanedInstances(options: {
    actorType: string
    ownerIds: readonly string[]
    cursor?: string
    limit: number
  }): Promise<InstanceRow[]> {
    const conditions = ["actor_type = ?"]
    const parameters: unknown[] = [options.actorType]
    if (options.ownerIds.length > 0) {
      conditions.push(`actor_id NOT IN (${parameterList(options.ownerIds.length)})`)
      parameters.push(...options.ownerIds)
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

  async previewRetention(target: RetentionTarget): Promise<number> {
    return this.settings.database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      const predicate = this.retentionPredicate({ target, now })
      const row = await connection.get<{ count: number | bigint }>(
        `SELECT COUNT(*) AS count FROM ${this.table(target)} WHERE ${predicate.sql}`,
        predicate.parameters,
      )
      return Number(row?.count ?? 0)
    })
  }

  async pruneRetention(target: RetentionTarget): Promise<number> {
    let count = 0
    while (true) {
      const deleted = await this.settings.database.transaction(async (connection) => {
        const now = await connection.nowMilliseconds()
        const predicate = this.retentionPredicate({ target, now })
        const candidates = await connection.all<{ id: string }>(
          `SELECT id FROM ${this.table(target)} WHERE ${predicate.sql}
           ORDER BY id LIMIT ?`,
          [...predicate.parameters, this.settings.pruneBatchSize],
        )
        if (candidates.length === 0) return 0
        const candidateIds = candidates.map(({ id }) => id)
        const result = await connection.run(
          `DELETE FROM ${this.table(target)}
           WHERE id IN (${parameterList(candidateIds.length)})
             AND ${predicate.sql}`,
          [...candidateIds, ...predicate.parameters],
        )
        return result.changes
      })
      if (deleted === 0) return count
      count += deleted
    }
  }

  private retentionPredicate(options: { target: RetentionTarget; now: number }): {
    sql: string
    parameters: unknown[]
  } {
    if (options.target === "messages") return this.messageRetentionPredicate(options.now)
    if (options.target === "instances") return this.instanceRetentionPredicate(options.now)
    return this.processRetentionPredicate(options.now)
  }

  private messageRetentionPredicate(now: number): { sql: string; parameters: unknown[] } {
    const table = this.table("messages")
    const retention = retentionPolicy({
      table,
      timestampColumn: "completed_at_ms",
      defaultRetention: this.settings.messageRetentionMilliseconds,
      overrides: this.settings.messageRetentionByActorType,
      now,
    })
    return {
      sql: `${retention.sql}
        AND ${table}.completed_at_ms IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("ready_messages")} ready
          WHERE ready.message_id = ${table}.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("claimed_messages")} claimed
          WHERE claimed.message_id = ${table}.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("dead_letters")} dead
          WHERE dead.message_id = ${table}.id OR dead.retried_message_id = ${table}.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("effects")} effects
          WHERE effects.message_id = ${table}.id AND effects.status != 'completed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("broadcasts")} broadcasts
          WHERE broadcasts.message_id = ${table}.id AND broadcasts.status != 'delivered'
        )`,
      parameters: retention.parameters,
    }
  }

  private instanceRetentionPredicate(now: number): { sql: string; parameters: unknown[] } {
    const table = this.table("instances")
    const retention = retentionPolicy({
      table,
      timestampColumn: "updated_at_ms",
      overrides: this.settings.instanceRetentionByActorType,
      now,
    })
    return {
      sql: `${retention.sql}
        AND ${table}.activation_owner_id IS NULL
        AND ${table}.paused = 0
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("ready_messages")} ready
          WHERE ready.instance_id = ${table}.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("claimed_messages")} claimed
          WHERE claimed.instance_id = ${table}.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("reminders")} reminders
          WHERE reminders.instance_id = ${table}.id AND reminders.status = 'scheduled'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("effects")} effects
          WHERE effects.instance_id = ${table}.id AND effects.status != 'completed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("broadcasts")} broadcasts
          WHERE broadcasts.instance_id = ${table}.id AND broadcasts.status != 'delivered'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("dead_letters")} dead
          WHERE dead.instance_id = ${table}.id
        )`,
      parameters: retention.parameters,
    }
  }

  private processRetentionPredicate(now: number): { sql: string; parameters: unknown[] } {
    const table = this.table("processes")
    return {
      sql: `${table}.shutdown_state = 'stopped'
        AND ${table}.stopped_at_ms IS NOT NULL
        AND ${table}.stopped_at_ms < ?
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("claimed_messages")} claimed
          WHERE claimed.process_id = ${table}.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table("instances")} instances
          WHERE instances.activation_owner_id = ${table}.id
        )`,
      parameters: [now - this.settings.processRetentionMilliseconds],
    }
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

  async resetForTesting(): Promise<void> {
    const tables = [
      "dead_letters",
      "claimed_messages",
      "ready_messages",
      "broadcasts",
      "effects",
      "reminders",
      "messages",
      "instances",
      "processes",
    ]
    await this.settings.database.transaction(async (connection) => {
      for (const table of tables) await connection.run(`DELETE FROM ${this.table(table)}`)
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
        `SELECT broadcasts.* FROM ${this.table("broadcasts")} broadcasts
         WHERE broadcasts.status = 'pending' AND broadcasts.available_at_ms <= ?
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table("broadcasts")} earlier
             WHERE earlier.instance_id = broadcasts.instance_id
               AND earlier.state_revision < broadcasts.state_revision
               AND earlier.status IN ('pending', 'processing')
           )
         ORDER BY broadcasts.available_at_ms, broadcasts.id
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
    lock?: "update"
  }): Promise<InstanceRow | undefined> {
    const { connection, actorType, actorId } = options
    return connection.get<InstanceRow>(
      `SELECT * FROM ${this.table("instances")} WHERE actor_type = ? AND actor_id = ?${
        options.lock === "update" ? " FOR UPDATE" : ""
      }`,
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
  }): Promise<void> {
    const { connection, turn } = options
    await connection.run(`DELETE FROM ${this.table("claimed_messages")} WHERE message_id = ?`, [
      turn.message.id,
    ])
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

function retentionPolicy(options: {
  table: string
  timestampColumn: string
  defaultRetention?: number
  overrides: Readonly<Record<string, number>>
  now: number
}): { sql: string; parameters: unknown[] } {
  const entries = Object.entries(options.overrides)
  const conditions: string[] = []
  const parameters: unknown[] = []
  for (const [actorType, retention] of entries) {
    conditions.push(
      `(${options.table}.actor_type = ? AND ${options.table}.${options.timestampColumn} < ?)`,
    )
    parameters.push(actorType, options.now - retention)
  }
  if (options.defaultRetention !== undefined) {
    const exclusion = entries.length
      ? `${options.table}.actor_type NOT IN (${parameterList(entries.length)}) AND `
      : ""
    conditions.push(`(${exclusion}${options.table}.${options.timestampColumn} < ?)`)
    if (entries.length) parameters.push(...entries.map(([actorType]) => actorType))
    parameters.push(options.now - options.defaultRetention)
  }
  return {
    sql: conditions.length === 0 ? "0 = 1" : `(${conditions.join(" OR ")})`,
    parameters,
  }
}

function parameterList(length: number): string {
  return Array.from({ length }, () => "?").join(", ")
}

function retryableMySQLDeadlock(options: {
  database: Database
  error: unknown
  attempt: number
}): boolean {
  if (options.database.family !== "mysql" || options.attempt >= 8) return false
  if (typeof options.error !== "object" || options.error === null) return false
  return (options.error as { code?: unknown }).code === "ER_LOCK_DEADLOCK"
}

async function transactionRetryBackoff(attempt: number): Promise<void> {
  const delay = 2 ** attempt + Math.floor(Math.random() * 5)
  await new Promise<void>((resolve) => setTimeout(resolve, delay))
}

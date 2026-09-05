import type { Instance, Message, Outbox, Reminder, Subscription } from "./records.js"
import type { CloudflareSettings } from "./configuration.js"
import { PayloadTooLarge } from "../errors.js"
import { utf8ByteLength } from "../serialization.js"

export class ActorStorage {
  constructor(
    readonly storage: DurableObjectStorage,
    readonly settings: CloudflareSettings,
  ) {
    storage.transactionSync(() => {
      storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, incarnation TEXT NOT NULL,
          sequence INTEGER NOT NULL, idempotency_key TEXT, status TEXT NOT NULL,
          available_at INTEGER NOT NULL, completed_at INTEGER, record TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS message_idempotency ON messages(incarnation, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS mailbox ON messages(incarnation, status, sequence);
        CREATE INDEX IF NOT EXISTS message_retention ON messages(completed_at);
        CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS receipt_message ON receipts(message_id);
        CREATE TABLE IF NOT EXISTS outboxes (
          id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL,
          destination TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL,
          available_at INTEGER NOT NULL, completed_at INTEGER, record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outbox_delivery ON outboxes(kind, destination, status, sequence);
        CREATE INDEX IF NOT EXISTS outbox_retention ON outboxes(completed_at);
        CREATE INDEX IF NOT EXISTS outbox_source ON outboxes(message_id);
        CREATE TABLE IF NOT EXISTS reminders (name TEXT PRIMARY KEY, status TEXT NOT NULL, due_at INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS reminder_due ON reminders(status, due_at);
        CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS subscription_expiry ON subscriptions(expires_at);
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
      `)
      const version = storage.sql
        .exec<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")
        .one().version
      if (version !== 1) throw new Error("unsupported Durable Objects storage schema")
      const instance = this.instance()
      if (instance) {
        instance.generation = String(BigInt(instance.generation) + 1n)
        this.saveInstance(instance)
      }
      for (const message of this.rows<Message>(
        "SELECT record FROM messages WHERE status = 'claimed'",
      )) {
        message.status = "ready"
        message.availableAt = Date.now()
        message.generation = null
        this.saveMessage(message)
      }
      for (const outbox of this.rows<Outbox>(
        "SELECT record FROM outboxes WHERE status = 'claimed'",
      )) {
        outbox.status = "pending"
        outbox.availableAt = Date.now()
        this.saveOutbox(outbox)
      }
    })
  }

  instance(): Instance | undefined {
    return this.metadata<Instance>("instance")
  }

  metadata<Value>(key: string): Value | undefined {
    const row = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM metadata WHERE key = ?", key)
      .toArray()[0]
    return row ? (JSON.parse(row.value) as Value) : undefined
  }

  saveMetadata(key: string, value: unknown): void {
    this.storage.sql.exec(
      "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      encodedRecord(value, [key]),
    )
  }

  saveInstance(instance: Instance): void {
    this.saveMetadata("instance", instance)
  }

  rows<Row>(query: string, parameters: readonly (string | number | null)[] = []): Row[] {
    return this.storage.sql
      .exec<{ record: string }>(query, ...parameters)
      .toArray()
      .map((row) => JSON.parse(row.record) as Row)
  }

  message(id: string): Message | undefined {
    return this.rows<Message>("SELECT record FROM messages WHERE id = ?", [id])[0]
  }

  saveMessage(message: Message): void {
    this.storage.sql.exec(
      `INSERT INTO messages(id, request_id, incarnation, sequence, idempotency_key, status, available_at, completed_at, record)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status,
      available_at = excluded.available_at, completed_at = excluded.completed_at, record = excluded.record`,
      message.id,
      message.requestId,
      message.incarnation,
      message.sequence,
      message.idempotencyKey,
      message.status,
      message.availableAt,
      message.completedAt,
      encodedRecord(message, [
        message.id,
        message.requestId,
        message.incarnation,
        message.idempotencyKey ?? "",
        message.status,
      ]),
    )
  }

  head(): Message | undefined {
    const instance = this.instance()
    if (!instance || instance.paused) return undefined
    return this.rows<Message>(
      "SELECT record FROM messages WHERE incarnation = ? AND status IN ('ready', 'claimed') ORDER BY sequence LIMIT 1",
      [instance.incarnation],
    )[0]
  }

  saveOutbox(outbox: Outbox): void {
    this.storage.sql.exec(
      `INSERT INTO outboxes(id, incarnation, message_id, kind, destination, sequence, status, available_at, completed_at, record)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status,
      available_at = excluded.available_at, completed_at = excluded.completed_at, record = excluded.record`,
      outbox.id,
      outbox.incarnation,
      outbox.messageId,
      outbox.kind,
      outbox.destination,
      outbox.sequence,
      outbox.status,
      outbox.availableAt,
      outbox.completedAt,
      encodedRecord(outbox, [
        outbox.id,
        outbox.incarnation,
        outbox.messageId,
        outbox.kind,
        outbox.destination,
        outbox.status,
      ]),
    )
  }

  outboxHeads(): Outbox[] {
    return this.rows<Outbox>(
      `SELECT current.record FROM outboxes current WHERE current.status IN ('pending', 'claimed')
      AND NOT EXISTS (SELECT 1 FROM outboxes earlier WHERE earlier.kind = current.kind
        AND earlier.destination = current.destination AND earlier.status IN ('pending', 'claimed', 'dead')
        AND (earlier.sequence < current.sequence OR (earlier.sequence = current.sequence AND earlier.rowid < current.rowid)))
      ORDER BY current.available_at, current.rowid LIMIT ?`,
      [this.settings.maxMessagesPerActivationPass],
    )
  }

  saveReminder(reminder: Reminder): void {
    this.storage.sql.exec(
      "INSERT INTO reminders(name, status, due_at, record) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET status = excluded.status, due_at = excluded.due_at, record = excluded.record",
      reminder.name,
      reminder.status,
      reminder.at,
      encodedRecord(reminder, [reminder.name, reminder.status]),
    )
  }

  saveSubscription(subscription: Subscription): void {
    this.storage.sql.exec(
      "INSERT INTO subscriptions(id, expires_at, record) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, record = excluded.record",
      subscription.id,
      subscription.expiresAt,
      encodedRecord(subscription, [subscription.id]),
    )
  }

  async atomic<Result>(callback: () => Result): Promise<Result> {
    return this.storage.transaction(async () => {
      const result = callback()
      await this.schedule()
      return result
    })
  }

  async schedule(): Promise<void> {
    const due: number[] = []
    if (this.metadata<boolean>("receiptCleanupPending")) due.push(Date.now())
    const head = this.head()
    if (head) due.push(head.availableAt)
    for (const outbox of this.outboxHeads()) due.push(outbox.availableAt)
    const reminder = this.instance()?.paused
      ? null
      : this.storage.sql
          .exec<{ due: number | null }>(
            "SELECT MIN(due_at) AS due FROM reminders WHERE status = 'scheduled'",
          )
          .one().due
    if (reminder !== null) {
      const count = this.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM messages WHERE status IN ('ready', 'claimed')",
        )
        .one().count
      const availableAt =
        count >= this.settings.maxMailboxLength
          ? Math.max(Date.now() + 1_000, head?.availableAt ?? Date.now() + 30_000)
          : reminder
      due.push(availableAt)
    }
    const subscription = this.storage.sql
      .exec<{ due: number | null }>("SELECT MIN(expires_at) AS due FROM subscriptions")
      .one().due
    if (subscription !== null) due.push(subscription)
    for (const query of [
      "SELECT MIN(completed_at) AS due FROM outboxes WHERE status = 'completed'",
      "SELECT MIN(completed_at) AS due FROM messages WHERE status IN ('completed', 'rejected') AND NOT EXISTS (SELECT 1 FROM outboxes WHERE outboxes.message_id = messages.id)",
    ]) {
      const retention = this.storage.sql.exec<{ due: number | null }>(query).one().due
      if (retention !== null) due.push(retention + this.settings.messageRetentionMilliseconds)
    }
    if (due.length === 0) {
      await this.storage.deleteAlarm()
      return
    }
    await this.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...due)))
  }

  prune(): void {
    const before = Date.now() - this.settings.messageRetentionMilliseconds
    const limit = this.settings.pruneBatchSize
    this.storage.sql.exec(
      "DELETE FROM subscriptions WHERE id IN (SELECT id FROM subscriptions WHERE expires_at <= ? LIMIT ?)",
      Date.now(),
      limit,
    )
    this.storage.sql.exec(
      "DELETE FROM outboxes WHERE id IN (SELECT id FROM outboxes WHERE status = 'completed' AND completed_at <= ? LIMIT ?)",
      before,
      limit,
    )
    const removedMessages = this.storage.sql.exec(
      `DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE completed_at <= ? AND status IN ('completed', 'rejected')
      AND NOT EXISTS (SELECT 1 FROM outboxes WHERE outboxes.message_id = messages.id) LIMIT ?)`,
      before,
      limit,
    )
    if (removedMessages.rowsWritten === 0 && !this.metadata<boolean>("receiptCleanupPending"))
      return
    const removedReceipts = this.storage.sql.exec(
      "DELETE FROM receipts WHERE request_id IN (SELECT request_id FROM receipts WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = receipts.message_id) LIMIT ?)",
      limit,
    )
    this.saveMetadata("receiptCleanupPending", removedReceipts.rowsWritten >= limit)
  }
}

function encodedRecord(value: unknown, indexedValues: string[]): string {
  const encoded = JSON.stringify(value)
  const size = indexedValues.reduce(
    (total, value) => total + utf8ByteLength(value),
    utf8ByteLength(encoded),
  )
  if (size > 1_999_000)
    throw new PayloadTooLarge("Durable Objects storage record exceeds the SQLite row limit")
  return encoded
}

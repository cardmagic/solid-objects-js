import { UnsupportedDatabase } from "./errors.js"
import type { DatabaseConnection, DatabaseFamily } from "./database/types.js"

const VERSION = 1

export async function installSchema(options: {
  connection: DatabaseConnection
  family: DatabaseFamily
  prefix: string
  schemaIdentity: string
}): Promise<void> {
  const { connection, family, prefix, schemaIdentity } = options
  if (family !== "sqlite") {
    throw new UnsupportedDatabase("schema installation is currently implemented for SQLite only")
  }

  const table = (name: string) => `${prefix}${name}`
  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("schema_migrations")} (
    version INTEGER PRIMARY KEY,
    schema_identity TEXT NOT NULL,
    installed_at_ms INTEGER NOT NULL
  ) STRICT`)

  const migration = await connection.get<{ schema_identity: string }>(
    `SELECT schema_identity FROM ${table("schema_migrations")} WHERE version = ?`,
    [VERSION],
  )
  if (migration && migration.schema_identity !== schemaIdentity) {
    throw new Error(`incompatible Solid Objects schema ${migration.schema_identity}`)
  }

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("processes")} (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL,
    stopped_at_ms INTEGER,
    shutdown_state TEXT NOT NULL CHECK (shutdown_state IN ('running', 'draining', 'stopped'))
  ) STRICT`)

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("instances")} (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    state TEXT NOT NULL,
    state_version INTEGER NOT NULL CHECK (state_version > 0),
    state_revision INTEGER NOT NULL DEFAULT 0,
    next_message_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_message_sequence > 0),
    activation_owner_id TEXT,
    activation_token TEXT,
    activation_expires_at_ms INTEGER,
    activation_generation INTEGER NOT NULL DEFAULT 0 CHECK (activation_generation >= 0),
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (actor_type, actor_id),
    FOREIGN KEY (activation_owner_id) REFERENCES ${table("processes")}(id) ON DELETE SET NULL
  ) STRICT`)

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("messages")} (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    operation TEXT NOT NULL,
    delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('async', 'sync', 'internal')),
    arguments TEXT NOT NULL,
    result TEXT,
    rejection TEXT,
    error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (instance_id, sequence),
    UNIQUE (actor_type, actor_id, request_id),
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE
  ) STRICT`)

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("ready_messages")} (
    message_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    available_at_ms INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES ${table("messages")}(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE
  ) STRICT`)
  await connection.run(
    `CREATE INDEX IF NOT EXISTS ${prefix}ready_poll ON ${table("ready_messages")}(available_at_ms, instance_id, sequence)`,
  )

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("claimed_messages")} (
    message_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    process_id TEXT NOT NULL,
    activation_token TEXT NOT NULL,
    activation_generation INTEGER NOT NULL CHECK (activation_generation > 0),
    claimed_at_ms INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES ${table("messages")}(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE,
    FOREIGN KEY (process_id) REFERENCES ${table("processes")}(id) ON DELETE CASCADE
  ) STRICT`)

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("reminders")} (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    run_at_ms INTEGER NOT NULL,
    arguments TEXT NOT NULL,
    interval_ms INTEGER,
    missed_policy TEXT NOT NULL CHECK (missed_policy IN ('latest', 'all')),
    occurrence INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'paused', 'completed')),
    claimed_by TEXT,
    claimed_at_ms INTEGER,
    error TEXT,
    UNIQUE (instance_id, operation),
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE
  ) STRICT`)

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("effects")} (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    name TEXT NOT NULL,
    arguments TEXT NOT NULL,
    success_operation TEXT,
    failure_operation TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'dead')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    available_at_ms INTEGER NOT NULL,
    claimed_by TEXT,
    result TEXT,
    error TEXT,
    FOREIGN KEY (message_id) REFERENCES ${table("messages")}(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE
  ) STRICT`)

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("broadcasts")} (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    state_revision INTEGER NOT NULL,
    observables TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at_ms INTEGER NOT NULL,
    claimed_by TEXT,
    error TEXT,
    FOREIGN KEY (message_id) REFERENCES ${table("messages")}(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE
  ) STRICT`)

  await connection.run(`CREATE TABLE IF NOT EXISTS ${table("dead_letters")} (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    instance_id TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    error TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES ${table("messages")}(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE
  ) STRICT`)

  const now = await connection.nowMilliseconds()
  await connection.run(
    `INSERT INTO ${table("schema_migrations")}(version, schema_identity, installed_at_ms)
     VALUES (?, ?, ?) ON CONFLICT(version) DO NOTHING`,
    [VERSION, schemaIdentity, now],
  )
}

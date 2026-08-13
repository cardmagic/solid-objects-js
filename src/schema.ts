import { UnsupportedDatabase } from "./errors.js"
import type { DatabaseConnection, DatabaseFamily } from "./database/types.js"

const BASE_VERSION = 1
const RETRY_LINK_VERSION = 2
const MESSAGE_IDENTITY_VERSION = 3
const PROCESS_IDENTITY_VERSION = 4
const LATEST_VERSION = PROCESS_IDENTITY_VERSION

export async function installSchema(options: {
  connection: DatabaseConnection
  family: DatabaseFamily
  prefix: string
  schemaIdentity: string
}): Promise<void> {
  const { connection, family, prefix, schemaIdentity } = options
  if (family !== "sqlite" && family !== "postgresql" && family !== "mysql") {
    throw new UnsupportedDatabase(
      "schema installation is currently implemented for SQLite, PostgreSQL, and MySQL",
    )
  }

  const table = (name: string) => `${prefix}${name}`
  const createTable = (sql: string) => connection.run(tableDefinition(sql, family))
  await createTable(`CREATE TABLE IF NOT EXISTS ${table("schema_migrations")} (
    version INTEGER PRIMARY KEY,
    schema_identity TEXT NOT NULL,
    installed_at_ms INTEGER NOT NULL
  ) STRICT`)

  const installedMigrations = await connection.all<{
    version: number | bigint
    schema_identity: string
  }>(`SELECT version, schema_identity FROM ${table("schema_migrations")} ORDER BY version`)
  for (const migration of installedMigrations) {
    if (migration.schema_identity !== schemaIdentity) {
      throw new Error(`incompatible Solid Objects schema ${migration.schema_identity}`)
    }
    if (Number(migration.version) > LATEST_VERSION) {
      throw new Error(`database schema version ${migration.version} is newer than this runtime`)
    }
  }

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("processes")} (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL,
    stopped_at_ms INTEGER,
    shutdown_state TEXT NOT NULL CHECK (shutdown_state IN ('running', 'draining', 'stopped'))
  ) STRICT`)

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("instances")} (
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

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("messages")} (
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

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("ready_messages")} (
    message_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    available_at_ms INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES ${table("messages")}(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES ${table("instances")}(id) ON DELETE CASCADE
  ) STRICT`)
  await createIndex({
    connection,
    family,
    table: table("ready_messages"),
    name: `${prefix}ready_poll`,
    columns: "available_at_ms, instance_id, sequence",
  })

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("claimed_messages")} (
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

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("reminders")} (
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

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("effects")} (
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

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("broadcasts")} (
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

  await createTable(`CREATE TABLE IF NOT EXISTS ${table("dead_letters")} (
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
    [BASE_VERSION, schemaIdentity, now],
  )

  const installedVersions = new Set(installedMigrations.map(({ version }) => Number(version)))
  if (!installedVersions.has(RETRY_LINK_VERSION)) {
    await connection.run(
      `ALTER TABLE ${table("dead_letters")} ADD COLUMN ${family === "postgresql" ? "IF NOT EXISTS " : ""}retried_message_id ${family === "mysql" ? "VARCHAR(255)" : "TEXT"}
       REFERENCES ${table("messages")}(id) ON DELETE SET NULL`,
    )
    await createIndex({
      connection,
      family,
      table: table("dead_letters"),
      name: `${prefix}dead_letters_retried_message`,
      columns: "retried_message_id",
    })
    await recordMigration({
      connection,
      table: table("schema_migrations"),
      version: RETRY_LINK_VERSION,
      schemaIdentity,
    })
  }

  if (!installedVersions.has(MESSAGE_IDENTITY_VERSION)) {
    await connection.run(
      `ALTER TABLE ${table("messages")} ADD COLUMN ${family === "postgresql" ? "IF NOT EXISTS " : ""}idempotency_key ${family === "mysql" ? "VARCHAR(255)" : "TEXT"}`,
    )
    await connection.run(
      `UPDATE ${table("messages")} SET idempotency_key = request_id WHERE idempotency_key IS NULL`,
    )
    await createIndex({
      connection,
      family,
      table: table("messages"),
      name: `${prefix}messages_idempotency`,
      columns: "actor_type, actor_id, idempotency_key",
      kind: "unique",
    })
    await recordMigration({
      connection,
      table: table("schema_migrations"),
      version: MESSAGE_IDENTITY_VERSION,
      schemaIdentity,
    })
  }

  if (installedVersions.has(PROCESS_IDENTITY_VERSION)) return
  const processColumns = [
    ["hostname", family === "mysql" ? "VARCHAR(255)" : "TEXT"],
    ["host_process_id", family === "sqlite" ? "INTEGER" : "BIGINT"],
    ["metadata", family === "mysql" ? "LONGTEXT" : "TEXT"],
  ] as const
  for (const [name, type] of processColumns) {
    await connection.run(
      `ALTER TABLE ${table("processes")} ADD COLUMN ${family === "postgresql" ? "IF NOT EXISTS " : ""}${name} ${type}`,
    )
  }
  await connection.run(
    `UPDATE ${table("processes")} SET hostname = ?, host_process_id = ?, metadata = ?
     WHERE hostname IS NULL OR host_process_id IS NULL OR metadata IS NULL`,
    ["unknown", 0, JSON.stringify({ solidObjectsVersion: "unknown", nodeVersion: "unknown" })],
  )
  await recordMigration({
    connection,
    table: table("schema_migrations"),
    version: PROCESS_IDENTITY_VERSION,
    schemaIdentity,
  })
}

async function recordMigration(options: {
  connection: DatabaseConnection
  table: string
  version: number
  schemaIdentity: string
}): Promise<void> {
  const installedAt = await options.connection.nowMilliseconds()
  await options.connection.run(
    `INSERT INTO ${options.table}(version, schema_identity, installed_at_ms)
     VALUES (?, ?, ?) ON CONFLICT(version) DO NOTHING`,
    [options.version, options.schemaIdentity, installedAt],
  )
}

function tableDefinition(sql: string, family: DatabaseFamily): string {
  if (family === "sqlite") return sql
  const definition = sql.replace(/\bINTEGER\b/g, "BIGINT").replace(/\s+STRICT\s*$/, "")
  if (family === "postgresql") return definition
  const documents = new Set(["state", "arguments", "result", "rejection", "error", "observables"])
  return `${definition.replace(
    /^(\s*)([A-Za-z_][A-Za-z0-9_]*) TEXT\b/gm,
    (_match, ...captures: string[]) => {
      const [space = "", column = ""] = captures
      return `${space}${column} ${documents.has(column) ? "LONGTEXT" : "VARCHAR(255)"}`
    },
  )} ENGINE=InnoDB`
}

async function createIndex(options: {
  connection: DatabaseConnection
  family: DatabaseFamily
  table: string
  name: string
  columns: string
  kind?: "unique"
}): Promise<void> {
  const kind = options.kind === "unique" ? "UNIQUE " : ""
  if (options.family !== "mysql") {
    await options.connection.run(
      `CREATE ${kind}INDEX IF NOT EXISTS ${options.name} ON ${options.table}(${options.columns})`,
    )
    return
  }
  const existing = await options.connection.get<{ present: number | string }>(
    `SELECT COUNT(*) AS present FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [options.table, options.name],
  )
  if (Number(existing?.present ?? 0) > 0) return
  await options.connection.run(
    `CREATE ${kind}INDEX ${options.name} ON ${options.table}(${options.columns})`,
  )
}

import { randomUUID } from "node:crypto"
import { Actor } from "./actor.js"
import type { DatabaseConnection } from "./database/types.js"
import { initialStateFor, validateDefinition } from "./definition.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import { jsonObject, readonlyCopy } from "./serialization.js"
import type { DeepReadonly, JsonObject } from "./types.js"

export type DoctorStatus = "pass" | "warn" | "fail" | "info" | "skip"

export interface DoctorCheck {
  readonly name: string
  readonly status: DoctorStatus
  readonly message: string
  readonly details?: DeepReadonly<JsonObject>
}

export interface DoctorReport {
  readonly healthy: boolean
  readonly checks: readonly DoctorCheck[]
}

export interface DoctorOptions {
  roundTrip?: "run" | "skip"
}

const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_migrations: ["version", "schema_identity", "installed_at_ms"],
  processes: [
    "id",
    "kind",
    "hostname",
    "host_process_id",
    "metadata",
    "heartbeat_at_ms",
    "shutdown_state",
    "shutdown_requested_at_ms",
    "stopped_at_ms",
  ],
  instances: [
    "id",
    "actor_type",
    "actor_id",
    "state",
    "state_version",
    "state_revision",
    "next_message_sequence",
    "activation_owner_id",
    "activation_token",
    "activation_expires_at_ms",
    "activation_generation",
    "paused",
  ],
  messages: [
    "id",
    "request_id",
    "idempotency_key",
    "instance_id",
    "operation",
    "delivery_mode",
    "arguments",
    "sequence",
    "attempt_count",
    "result",
    "error",
    "rejection",
    "completed_at_ms",
  ],
  ready_messages: ["message_id", "instance_id", "sequence", "available_at_ms"],
  claimed_messages: [
    "message_id",
    "instance_id",
    "process_id",
    "activation_token",
    "activation_generation",
    "claimed_at_ms",
  ],
  reminders: ["id", "instance_id", "operation", "run_at_ms", "status"],
  effects: ["id", "message_id", "instance_id", "name", "status", "available_at_ms"],
  broadcasts: ["id", "message_id", "instance_id", "state_revision", "status", "available_at_ms"],
  dead_letters: ["id", "message_id", "instance_id", "attempts", "error", "retried_message_id"],
}

class DoctorProbe extends Actor {
  static override readonly actorType = "solid_objects_doctor"

  ping({ value }: { value: string }): string {
    return value
  }
}

export class Doctor {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async run(options: DoctorOptions = {}): Promise<DoctorReport> {
    const configuration = this.checkConfiguration()
    const schema = await this.checkSchema()
    const checks: DoctorCheck[] = [
      configuration,
      schema,
      await this.checkAuthorization(),
      await this.checkDatabase(),
    ]
    checks.push(
      schema.status === "fail"
        ? check({ name: "runtime", status: "skip", message: "schema check failed" })
        : await this.checkRuntime(),
    )
    if (options.roundTrip === "skip") {
      checks.push(
        check({ name: "roundTrip", status: "skip", message: "round trip was not requested" }),
      )
    } else if (configuration.status === "fail" || schema.status === "fail") {
      checks.push(
        check({
          name: "roundTrip",
          status: "skip",
          message: "configuration or schema check failed",
        }),
      )
    } else {
      checks.push(await this.checkRoundTrip())
    }
    const frozenChecks = Object.freeze(checks)
    return Object.freeze({
      healthy: frozenChecks.every(({ status }) => status !== "fail"),
      checks: frozenChecks,
    })
  }

  private checkConfiguration(): DoctorCheck {
    return check({
      name: "configuration",
      status: "pass",
      message: "runtime configuration is valid",
      details: {
        databaseFamily: this.runtime.settings.database.family,
        tableNamePrefix: this.runtime.settings.tableNamePrefix,
      },
    })
  }

  private async checkSchema(): Promise<DoctorCheck> {
    try {
      const missingTables: string[] = []
      const missingColumns: string[] = []
      await this.runtime.settings.database.connection(async (connection) => {
        const schema = await databaseSchema({
          connection,
          family: this.runtime.settings.database.family,
        })
        for (const [name, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
          const table = this.runtime.repository.table(name)
          const columns = schema.get(table)
          if (!columns) {
            missingTables.push(table)
            continue
          }
          for (const column of expectedColumns) {
            if (!columns.has(column)) missingColumns.push(`${table}.${column}`)
          }
        }
      })
      if (missingTables.length > 0) {
        return check({
          name: "schema",
          status: "fail",
          message: `missing tables: ${missingTables.join(", ")}`,
        })
      }
      if (missingColumns.length > 0) {
        return check({
          name: "schema",
          status: "fail",
          message: `missing columns: ${missingColumns.join(", ")}`,
        })
      }
      const migrations = await this.runtime.settings.database.connection((connection) =>
        connection.all<{ version: number | bigint; schema_identity: string }>(
          `SELECT version, schema_identity FROM ${this.runtime.repository.table("schema_migrations")}
           ORDER BY version`,
        ),
      )
      const versions = migrations.map(({ version }) => Number(version))
      const wrongIdentity = migrations.find(
        ({ schema_identity: identity }) =>
          identity !== this.runtime.settings.database.schemaIdentity,
      )
      if (wrongIdentity) {
        return check({
          name: "schema",
          status: "fail",
          message: `incompatible schema identity ${wrongIdentity.schema_identity}`,
        })
      }
      if (versions.join(",") !== "1,2,3,4,5") {
        return check({
          name: "schema",
          status: "fail",
          message: `expected schema migrations 1, 2, 3, 4, 5; found ${versions.join(", ")}`,
        })
      }
      return check({
        name: "schema",
        status: "pass",
        message: "schema matches this runtime",
        details: { versions },
      })
    } catch (error) {
      return failedCheck("schema", error)
    }
  }

  private async checkAuthorization(): Promise<DoctorCheck> {
    const configured = this.runtime.settings.authorizationPoliciesConfigured
    const missing = Object.entries(configured)
      .filter(([_name, present]) => !present)
      .map(([name]) => name)
    if (missing.length > 0) {
      return check({
        name: "authorization",
        status: "warn",
        message: `policies not explicitly configured: ${missing.join(", ")}`,
        details: { configured },
      })
    }

    const neutralContext: Record<string, "allow" | "deny" | "unknown"> = {}
    for (const [name, probe] of Object.entries(this.authorizationProbes())) {
      try {
        neutralContext[name] = (await probe()) ? "allow" : "deny"
      } catch {
        neutralContext[name] = "unknown"
      }
    }
    const allowed = Object.entries(neutralContext)
      .filter(([_name, outcome]) => outcome === "allow")
      .map(([name]) => name)
    const unknown = Object.entries(neutralContext)
      .filter(([_name, outcome]) => outcome === "unknown")
      .map(([name]) => name)
    const sensitiveAllowed = allowed.filter((name) =>
      ["authorizeDestroy", "authorizeSubscription", "authorizeAdministration"].includes(name),
    )
    if (allowed.length === 0 && unknown.length === 0) {
      return check({
        name: "authorization",
        status: "warn",
        message: "all five policies denied a neutral context; review them before use",
        details: { configured, neutralContext },
      })
    }
    if (sensitiveAllowed.length > 0) {
      return check({
        name: "authorization",
        status: "warn",
        message: `sensitive policies allowed a neutral context: ${sensitiveAllowed.join(", ")}`,
        details: { configured, neutralContext },
      })
    }
    if (unknown.length > 0) {
      return check({
        name: "authorization",
        status: "warn",
        message: `${unknown.join(", ")} could not evaluate without application context`,
        details: { configured, neutralContext },
      })
    }
    return check({
      name: "authorization",
      status: "pass",
      message: `${allowed.length} of 5 policies allowed a neutral context`,
      details: { configured, neutralContext },
    })
  }

  private authorizationProbes(): Record<string, () => boolean | Promise<boolean>> {
    const actor = {
      actorType: DoctorProbe.actorType,
      actorId: "doctor",
      authorizationContext: undefined,
    }
    return {
      authorizeMessage: () =>
        this.runtime.settings.authorizeMessage({
          ...actor,
          operation: "ping",
          arguments: { value: "doctor" },
        }),
      authorizeQuery: () =>
        this.runtime.settings.authorizeQuery({
          ...actor,
          operation: "value",
          arguments: {},
        }),
      authorizeDestroy: () => this.runtime.settings.authorizeDestroy(actor),
      authorizeSubscription: () => this.runtime.settings.authorizeSubscription(actor),
      authorizeAdministration: () =>
        this.runtime.settings.authorizeAdministration({
          action: "doctor",
          resource: "runtime",
          authorizationContext: undefined,
        }),
    }
  }

  private async checkDatabase(): Promise<DoctorCheck> {
    try {
      if (this.runtime.settings.database.family === "postgresql") {
        return await this.checkPostgreSQL()
      }
      if (this.runtime.settings.database.family === "mysql") return await this.checkMySQL()
      const row = await this.runtime.settings.database.connection((connection) =>
        connection.get<{ version: string }>("SELECT sqlite_version() AS version"),
      )
      const version = row?.version ?? "unknown"
      if (version !== "unknown" && compareVersions(version, "3.35.0") < 0) {
        return check({
          name: "database",
          status: "warn",
          message: `SQLite ${version} is older than tested minimum 3.35.0`,
          details: { version },
        })
      }
      return check({
        name: "database",
        status: "pass",
        message: `SQLite ${version} meets the tested minimum`,
        details: { version },
      })
    } catch (error) {
      return failedCheck("database", error)
    }
  }

  private async checkPostgreSQL(): Promise<DoctorCheck> {
    const row = await this.runtime.settings.database.connection((connection) =>
      connection.get<{ server_version: string }>("SHOW server_version"),
    )
    const version = row?.server_version ?? "unknown"
    if (version !== "unknown" && compareVersions(version, "14") < 0) {
      return check({
        name: "database",
        status: "warn",
        message: `PostgreSQL ${version} is older than tested minimum 14`,
        details: { version },
      })
    }
    return check({
      name: "database",
      status: "pass",
      message: `PostgreSQL ${version} meets the tested minimum`,
      details: { version },
    })
  }

  private async checkMySQL(): Promise<DoctorCheck> {
    const result = await this.runtime.settings.database.connection(async (connection) => {
      const version = await connection.get<{ version: string }>("SELECT VERSION() AS version")
      const invalidEngines = await connection.all<{ table_name: string; engine: string }>(
        `SELECT table_name AS table_name, engine AS engine FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name LIKE ? AND engine <> 'InnoDB'`,
        [`${this.runtime.settings.tableNamePrefix}%`],
      )
      return { version: version?.version ?? "unknown", invalidEngines }
    })
    if (result.invalidEngines.length > 0) {
      return check({
        name: "database",
        status: "fail",
        message: "MySQL Solid Objects tables must use InnoDB",
        details: { tables: result.invalidEngines.map(({ table_name }) => table_name) },
      })
    }
    if (result.version !== "unknown" && compareVersions(result.version, "8.0") < 0) {
      return check({
        name: "database",
        status: "warn",
        message: `MySQL ${result.version} is older than tested minimum 8.0`,
        details: { version: result.version },
      })
    }
    return check({
      name: "database",
      status: "pass",
      message: `MySQL ${result.version} meets the tested minimum and uses InnoDB`,
      details: { version: result.version },
    })
  }

  private async checkRuntime(): Promise<DoctorCheck> {
    try {
      const roles = await this.runtime.settings.database.connection(async (connection) => {
        const now = await connection.nowMilliseconds()
        const rows = await connection.all<{ kind: string; count: number | bigint }>(
          `SELECT kind, COUNT(*) AS count FROM ${this.runtime.repository.table("processes")}
           WHERE shutdown_state = 'running' AND heartbeat_at_ms > ?
           GROUP BY kind ORDER BY kind`,
          [now - this.runtime.settings.processAliveThresholdMilliseconds],
        )
        return Object.fromEntries(rows.map(({ kind, count }) => [kind, Number(count)]))
      })
      if (Object.keys(roles).length === 0) {
        return check({
          name: "runtime",
          status: "info",
          message: "no live runtime roles",
          details: { roles },
        })
      }
      return check({
        name: "runtime",
        status: "pass",
        message: "live runtime roles found",
        details: { roles },
      })
    } catch (error) {
      return failedCheck("runtime", error)
    }
  }

  private async checkRoundTrip(): Promise<DoctorCheck> {
    const actorId = randomUUID()
    const processId = randomUUID()
    let result: DoctorCheck
    try {
      const definition = validateDefinition(DoctorProbe)
      this.runtime.register(DoctorProbe)
      const value = randomUUID()
      const message = await this.runtime.repository.enqueue({
        actorType: definition.type,
        actorId,
        operation: "ping",
        deliveryMode: "sync",
        arguments: { value },
        initialState: initialStateFor(definition),
        stateVersion: definition.stateVersion,
      })
      await this.runtime.repository.registerProcess(processId, "doctor")
      const turn = await this.runtime.repository.claim(processId, {
        instanceId: message.instance_id,
      })
      if (!turn) throw new Error("doctor could not claim its probe message")
      const execution = await this.runtime.executeTurn(turn)
      await this.runtime.deactivateActor({
        turn,
        actor: execution.actor,
        lifecycle: execution.activated ? "activated" : "unactivated",
      })
      const completed = await this.runtime.repository.findMessage(message.id)
      if (completed?.result === null || JSON.parse(completed?.result ?? "null") !== value) {
        throw new Error("doctor round trip returned an unexpected result")
      }
      result = check({
        name: "roundTrip",
        status: "pass",
        message: "durable actor round trip completed",
      })
    } catch (error) {
      result = failedCheck("roundTrip", error)
    }
    const cleanupFailure = await this.removeProbe({ actorId, processId })
    if (!cleanupFailure || result.status === "fail") return result
    return check({
      name: "roundTrip",
      status: "warn",
      message: `${result.message}; probe cleanup failed: ${cleanupFailure}`,
    })
  }

  private async removeProbe(options: {
    actorId: string
    processId: string
  }): Promise<string | undefined> {
    try {
      await this.runtime.repository.stopProcess(options.processId)
      await this.runtime.settings.database.transaction(async (connection) => {
        await connection.run(
          `DELETE FROM ${this.runtime.repository.table("instances")}
           WHERE actor_type = ? AND actor_id = ?`,
          [DoctorProbe.actorType, options.actorId],
        )
        await connection.run(
          `DELETE FROM ${this.runtime.repository.table("processes")} WHERE id = ?`,
          [options.processId],
        )
      })
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

async function sqliteSchema(connection: DatabaseConnection): Promise<Map<string, Set<string>>> {
  const tables = await connection.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  )
  const schema = new Map<string, Set<string>>()
  for (const { name } of tables) {
    const columns = await connection.all<{ name: string }>(`PRAGMA table_info(${name})`)
    schema.set(name, new Set(columns.map(({ name: columnName }) => columnName)))
  }
  return schema
}

async function postgresqlSchema(connection: DatabaseConnection): Promise<Map<string, Set<string>>> {
  const rows = await connection.all<{ table_name: string; column_name: string }>(
    `SELECT table_name AS table_name, column_name AS column_name FROM information_schema.columns
     WHERE table_schema = current_schema()`,
  )
  const schema = new Map<string, Set<string>>()
  for (const row of rows) {
    const columns = schema.get(row.table_name) ?? new Set()
    columns.add(row.column_name)
    schema.set(row.table_name, columns)
  }
  return schema
}

async function mysqlSchema(connection: DatabaseConnection): Promise<Map<string, Set<string>>> {
  const rows = await connection.all<{ table_name: string; column_name: string }>(
    `SELECT table_name AS table_name, column_name AS column_name FROM information_schema.columns
     WHERE table_schema = DATABASE()`,
  )
  return schemaFromRows(rows)
}

async function databaseSchema(options: {
  connection: DatabaseConnection
  family: "sqlite" | "postgresql" | "mysql"
}): Promise<Map<string, Set<string>>> {
  if (options.family === "sqlite") return sqliteSchema(options.connection)
  if (options.family === "postgresql") return postgresqlSchema(options.connection)
  return mysqlSchema(options.connection)
}

function schemaFromRows(
  rows: Array<{ table_name: string; column_name: string }>,
): Map<string, Set<string>> {
  const schema = new Map<string, Set<string>>()
  for (const row of rows) {
    const columns = schema.get(row.table_name) ?? new Set()
    columns.add(row.column_name)
    schema.set(row.table_name, columns)
  }
  return schema
}

function check(options: {
  name: string
  status: DoctorStatus
  message: string
  details?: JsonObject
}): DoctorCheck {
  return Object.freeze({
    name: options.name,
    status: options.status,
    message: options.message,
    ...(options.details === undefined
      ? {}
      : { details: readonlyCopy(jsonObject(options.details)) }),
  })
}

function failedCheck(name: string, error: unknown): DoctorCheck {
  const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return check({ name, status: "fail", message: failure })
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

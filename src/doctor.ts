import { randomUUID } from "node:crypto"
import { Actor } from "./actor.js"
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
  processes: ["id", "kind", "heartbeat_at_ms", "shutdown_state", "stopped_at_ms"],
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
      this.checkAuthorization(),
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
        const tables = await connection.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        const tableNames = new Set(tables.map(({ name }) => name))
        for (const [name, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
          const table = this.runtime.repository.table(name)
          if (!tableNames.has(table)) {
            missingTables.push(table)
            continue
          }
          const columns = await connection.all<{ name: string }>(`PRAGMA table_info(${table})`)
          const columnNames = new Set(columns.map(({ name: columnName }) => columnName))
          for (const column of expectedColumns) {
            if (!columnNames.has(column)) missingColumns.push(`${table}.${column}`)
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
      if (versions.join(",") !== "1,2") {
        return check({
          name: "schema",
          status: "fail",
          message: `expected schema migrations 1, 2; found ${versions.join(", ")}`,
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

  private checkAuthorization(): DoctorCheck {
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
    return check({
      name: "authorization",
      status: "pass",
      message: "all authorization policies are configured",
      details: { configured },
    })
  }

  private async checkDatabase(): Promise<DoctorCheck> {
    try {
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
      await this.runtime.executeTurn(turn)
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

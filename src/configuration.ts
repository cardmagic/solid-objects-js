import { InvalidActor } from "./errors.js"
import type { Database } from "./database/types.js"
import type { JsonValue, Logger, LongRunningComponent } from "./types.js"

export interface AuthorizationInput {
  actorType: string
  actorId: string
  operation: string
  arguments: Record<string, JsonValue>
  authorizationContext: unknown
}

export interface DestroyAuthorizationInput {
  actorType: string
  actorId: string
  authorizationContext: unknown
}

export interface AdministrationAuthorizationInput {
  action: string
  resource: string
  resourceId?: string
  authorizationContext: unknown
}

export interface SolidObjectsConfiguration {
  database: Database
  tableNamePrefix?: string
  pollingIntervalMilliseconds?: number
  syncPollingIntervalMilliseconds?: number
  leaseDurationMilliseconds?: number
  leaseRenewalIntervalMilliseconds?: number
  maxMailboxLength?: number
  maxPayloadBytes?: number
  maxStateBytes?: number
  maxResultBytes?: number
  maxAttempts?: number
  retryDelayMilliseconds?: (attempt: number) => number
  processHeartbeatIntervalMilliseconds?: number
  processAliveThresholdMilliseconds?: number
  workerCount?: number
  effectWorkerCount?: number
  broadcastWorkerCount?: number
  reminderSchedulerCount?: number
  messageRetentionMilliseconds?: number
  messageRetentionByActorType?: Readonly<Record<string, number>>
  instanceRetentionByActorType?: Readonly<Record<string, number>>
  processRetentionMilliseconds?: number
  pruneBatchSize?: number
  logger?: Logger
  authorizeMessage?: (input: AuthorizationInput) => boolean | Promise<boolean>
  authorizeQuery?: (input: AuthorizationInput) => boolean | Promise<boolean>
  authorizeDestroy?: (input: DestroyAuthorizationInput) => boolean | Promise<boolean>
  authorizeAdministration?: (input: AdministrationAuthorizationInput) => boolean | Promise<boolean>
  broadcast?: (event: BroadcastEvent) => Promise<void>
}

export interface BroadcastEvent {
  actorType: string
  actorId: string
  instanceId: string
  revision: string
  observables: Record<string, JsonValue>
}

export interface RuntimeSettings extends Required<
  Omit<SolidObjectsConfiguration, "logger" | "broadcast">
> {
  logger: Logger
  broadcast?: (event: BroadcastEvent) => Promise<void>
}

const consoleLogger: Logger = {
  debug: (entry) => console.debug(entry),
  info: (entry) => console.info(entry),
  warn: (entry) => console.warn(entry),
  error: (entry) => console.error(entry),
}

export function buildSettings(configuration: SolidObjectsConfiguration): RuntimeSettings {
  const settings: RuntimeSettings = {
    database: configuration.database,
    tableNamePrefix: configuration.tableNamePrefix ?? "solid_objects_",
    pollingIntervalMilliseconds: configuration.pollingIntervalMilliseconds ?? 100,
    syncPollingIntervalMilliseconds: configuration.syncPollingIntervalMilliseconds ?? 50,
    leaseDurationMilliseconds: configuration.leaseDurationMilliseconds ?? 30_000,
    leaseRenewalIntervalMilliseconds: configuration.leaseRenewalIntervalMilliseconds ?? 10_000,
    maxMailboxLength: configuration.maxMailboxLength ?? 10_000,
    maxPayloadBytes: configuration.maxPayloadBytes ?? 1_048_576,
    maxStateBytes: configuration.maxStateBytes ?? 5_242_880,
    maxResultBytes: configuration.maxResultBytes ?? 1_048_576,
    maxAttempts: configuration.maxAttempts ?? 5,
    retryDelayMilliseconds:
      configuration.retryDelayMilliseconds ??
      ((attempt) => Math.min(2 ** (attempt - 1), 60) * 1_000),
    processHeartbeatIntervalMilliseconds:
      configuration.processHeartbeatIntervalMilliseconds ?? 15_000,
    processAliveThresholdMilliseconds: configuration.processAliveThresholdMilliseconds ?? 60_000,
    workerCount: configuration.workerCount ?? 1,
    effectWorkerCount: configuration.effectWorkerCount ?? 1,
    broadcastWorkerCount: configuration.broadcastWorkerCount ?? 1,
    reminderSchedulerCount: configuration.reminderSchedulerCount ?? 1,
    messageRetentionMilliseconds: configuration.messageRetentionMilliseconds ?? 30 * 86_400_000,
    messageRetentionByActorType: Object.freeze({
      ...(configuration.messageRetentionByActorType ?? {}),
    }),
    instanceRetentionByActorType: Object.freeze({
      ...(configuration.instanceRetentionByActorType ?? {}),
    }),
    processRetentionMilliseconds: configuration.processRetentionMilliseconds ?? 7 * 86_400_000,
    pruneBatchSize: configuration.pruneBatchSize ?? 1_000,
    logger: configuration.logger ?? consoleLogger,
    authorizeMessage: configuration.authorizeMessage ?? (() => false),
    authorizeQuery: configuration.authorizeQuery ?? (() => false),
    authorizeDestroy: configuration.authorizeDestroy ?? (() => false),
    authorizeAdministration: configuration.authorizeAdministration ?? (() => false),
  }

  if (configuration.broadcast !== undefined) settings.broadcast = configuration.broadcast
  validateSettings(settings)
  return settings
}

export interface ComponentRegistration {
  count: number
  factory(): LongRunningComponent
}

export function validateComponent(component: LongRunningComponent): void {
  for (const name of ["run", "requestShutdown", "stopped", "stop"] as const) {
    if (typeof component[name] !== "function") {
      throw new InvalidActor(`a registered component must implement ${name}`)
    }
  }
}

function validateSettings(settings: RuntimeSettings): void {
  if (!/^[a-z][a-z0-9_]*$/.test(settings.tableNamePrefix)) {
    throw new TypeError("tableNamePrefix must contain lowercase letters, digits, and underscores")
  }

  const positive: Record<string, number> = {
    pollingIntervalMilliseconds: settings.pollingIntervalMilliseconds,
    syncPollingIntervalMilliseconds: settings.syncPollingIntervalMilliseconds,
    leaseDurationMilliseconds: settings.leaseDurationMilliseconds,
    leaseRenewalIntervalMilliseconds: settings.leaseRenewalIntervalMilliseconds,
    maxMailboxLength: settings.maxMailboxLength,
    maxPayloadBytes: settings.maxPayloadBytes,
    maxStateBytes: settings.maxStateBytes,
    maxResultBytes: settings.maxResultBytes,
    maxAttempts: settings.maxAttempts,
    processHeartbeatIntervalMilliseconds: settings.processHeartbeatIntervalMilliseconds,
    processAliveThresholdMilliseconds: settings.processAliveThresholdMilliseconds,
    messageRetentionMilliseconds: settings.messageRetentionMilliseconds,
    processRetentionMilliseconds: settings.processRetentionMilliseconds,
  }
  for (const [name, value] of Object.entries(positive)) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  }

  if (settings.leaseDurationMilliseconds <= settings.leaseRenewalIntervalMilliseconds) {
    throw new TypeError("leaseDurationMilliseconds must exceed leaseRenewalIntervalMilliseconds")
  }

  const roleCounts: Record<string, number> = {
    workerCount: settings.workerCount,
    effectWorkerCount: settings.effectWorkerCount,
    broadcastWorkerCount: settings.broadcastWorkerCount,
    reminderSchedulerCount: settings.reminderSchedulerCount,
  }
  for (const [name, value] of Object.entries(roleCounts)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError(`${name} must be a non-negative integer`)
  }

  if (!Number.isSafeInteger(settings.pruneBatchSize) || settings.pruneBatchSize < 1) {
    throw new TypeError("pruneBatchSize must be a positive safe integer")
  }
  validateRetentionOverrides("messageRetentionByActorType", settings.messageRetentionByActorType)
  validateRetentionOverrides("instanceRetentionByActorType", settings.instanceRetentionByActorType)

  const roleCount =
    settings.workerCount +
    settings.effectWorkerCount +
    settings.reminderSchedulerCount +
    (settings.broadcast ? settings.broadcastWorkerCount : 0)
  if (roleCount === 0) throw new TypeError("at least one runtime role must be configured")
}

function validateRetentionOverrides(
  name: string,
  overrides: Readonly<Record<string, number>>,
): void {
  for (const [actorType, retention] of Object.entries(overrides)) {
    if (actorType.length === 0) throw new TypeError(`${name} actor types must not be empty`)
    if (!Number.isFinite(retention) || retention <= 0) {
      throw new TypeError(`${name} values must be positive`)
    }
  }
}

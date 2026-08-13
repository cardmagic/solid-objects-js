import { InvalidActor } from "./errors.js"
import type { Database } from "./database/types.js"
import type { DeepReadonly, JsonObject, JsonValue, Logger, LongRunningComponent } from "./types.js"
import { InProcessWakeUpAdapter, type WakeUpAdapter } from "./wake-up.js"

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

export interface SubscriptionAuthorizationInput {
  actorType: string
  actorId: string
  authorizationContext: unknown
}

export interface InstrumentationEvent {
  readonly name: string
  readonly occurredAt: string
  readonly attributes: DeepReadonly<JsonObject>
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
  maxMessagesPerActivationPass?: number
  retryDelayMilliseconds?: (attempt: number) => number
  processHeartbeatIntervalMilliseconds?: number
  processAliveThresholdMilliseconds?: number
  supervisorRestartDelayMilliseconds?: number
  supervisorMaximumRestartDelayMilliseconds?: number
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
  authorizeSubscription?: (input: SubscriptionAuthorizationInput) => boolean | Promise<boolean>
  instrumentation?: (event: InstrumentationEvent) => void
  broadcast?: (event: BroadcastEvent) => Promise<void>
  wakeUp?: WakeUpAdapter
}

export interface BroadcastEvent {
  readonly actorType: string
  readonly actorId: string
  readonly instanceId: string
  readonly revision: string
  readonly observables: DeepReadonly<JsonObject>
}

export interface RuntimeSettings extends Required<
  Omit<SolidObjectsConfiguration, "logger" | "broadcast" | "instrumentation" | "wakeUp">
> {
  logger: Logger
  broadcast?: (event: BroadcastEvent) => Promise<void>
  instrumentation?: (event: InstrumentationEvent) => void
  wakeUp: WakeUpAdapter
  authorizationPoliciesConfigured: Readonly<Record<string, boolean>>
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
    maxMessagesPerActivationPass: configuration.maxMessagesPerActivationPass ?? 50,
    retryDelayMilliseconds:
      configuration.retryDelayMilliseconds ??
      ((attempt) => Math.min(2 ** (attempt - 1), 60) * 1_000),
    processHeartbeatIntervalMilliseconds:
      configuration.processHeartbeatIntervalMilliseconds ?? 15_000,
    processAliveThresholdMilliseconds: configuration.processAliveThresholdMilliseconds ?? 60_000,
    supervisorRestartDelayMilliseconds: configuration.supervisorRestartDelayMilliseconds ?? 100,
    supervisorMaximumRestartDelayMilliseconds:
      configuration.supervisorMaximumRestartDelayMilliseconds ?? 10_000,
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
    wakeUp: configuration.wakeUp ?? new InProcessWakeUpAdapter(),
    authorizeMessage: configuration.authorizeMessage ?? (() => false),
    authorizeQuery: configuration.authorizeQuery ?? (() => false),
    authorizeDestroy: configuration.authorizeDestroy ?? (() => false),
    authorizeAdministration: configuration.authorizeAdministration ?? (() => false),
    authorizeSubscription: configuration.authorizeSubscription ?? (() => false),
    authorizationPoliciesConfigured: Object.freeze({
      authorizeMessage: configuration.authorizeMessage !== undefined,
      authorizeQuery: configuration.authorizeQuery !== undefined,
      authorizeDestroy: configuration.authorizeDestroy !== undefined,
      authorizeAdministration: configuration.authorizeAdministration !== undefined,
      authorizeSubscription: configuration.authorizeSubscription !== undefined,
    }),
  }

  if (configuration.broadcast !== undefined) settings.broadcast = configuration.broadcast
  if (configuration.instrumentation !== undefined) {
    settings.instrumentation = configuration.instrumentation
  }
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
  for (const name of ["watch", "notify", "close"] as const) {
    if (typeof settings.wakeUp[name] !== "function") {
      throw new TypeError(`wakeUp must implement ${name}`)
    }
  }
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
    supervisorRestartDelayMilliseconds: settings.supervisorRestartDelayMilliseconds,
    supervisorMaximumRestartDelayMilliseconds: settings.supervisorMaximumRestartDelayMilliseconds,
    messageRetentionMilliseconds: settings.messageRetentionMilliseconds,
    processRetentionMilliseconds: settings.processRetentionMilliseconds,
  }
  if (
    !Number.isSafeInteger(settings.maxMessagesPerActivationPass) ||
    settings.maxMessagesPerActivationPass < 1
  ) {
    throw new TypeError("maxMessagesPerActivationPass must be a positive safe integer")
  }
  for (const [name, value] of Object.entries(positive)) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  }

  if (settings.leaseDurationMilliseconds <= settings.leaseRenewalIntervalMilliseconds) {
    throw new TypeError("leaseDurationMilliseconds must exceed leaseRenewalIntervalMilliseconds")
  }
  if (
    settings.supervisorMaximumRestartDelayMilliseconds < settings.supervisorRestartDelayMilliseconds
  ) {
    throw new TypeError(
      "supervisorMaximumRestartDelayMilliseconds must be at least supervisorRestartDelayMilliseconds",
    )
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
    (broadcastsEnabled(settings) ? settings.broadcastWorkerCount : 0)
  if (roleCount === 0) throw new TypeError("at least one runtime role must be configured")
}

export function broadcastsEnabled(settings: RuntimeSettings): boolean {
  return (
    settings.broadcast !== undefined ||
    settings.authorizationPoliciesConfigured.authorizeSubscription === true
  )
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

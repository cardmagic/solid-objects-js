import type { Database } from "./database/types.js"
import type { Logger } from "./types.js"
import {
  InProcessWakeUpAdapter,
  WAKE_UP_NAMES,
  type NotificationWakeUpAdapter,
  type WakeUpAdapter,
  type WakeUpCapability,
  type WakeUpSetting,
} from "./wake-up.js"

export const REDIS_URL_VARIABLE = "SOLID_OBJECTS_REDIS_URL"
export const POSTGRESQL_FLOOR_MILLISECONDS = 2.9
export const REDIS_FLOOR_MILLISECONDS = 5.7
export const PROBE_TIMEOUT_MILLISECONDS = 2_000
export const PROBE_CHANNEL_PREFIX = "solid_objects_probe"

const PROBE_ROLE = "actors" as const

export interface SelectedWakeUp {
  readonly adapter: WakeUpAdapter
  readonly capability: WakeUpCapability
}

export interface WakeUpSelectionOptions {
  setting: WakeUpSetting
  database: Database
  idlePollingIntervalMilliseconds: number
  logger: Logger
  redisUrl?: string
  probeTimeoutMilliseconds?: number
}

export async function selectWakeUp(options: WakeUpSelectionOptions): Promise<SelectedWakeUp> {
  const { setting } = options
  if (typeof setting !== "string") return configured(setting)
  if (setting === "automatic") return await automatic(options)
  return await named({ ...options, name: setting })
}

function configured(adapter: WakeUpAdapter): SelectedWakeUp {
  if (adapter.capability) return { adapter, capability: adapter.capability }
  return {
    adapter,
    capability: {
      adapter: "configured",
      crossesProcesses: true,
      reason: "an adapter was configured, so selection did not run",
    },
  }
}

async function named(options: WakeUpSelectionOptions & { name: string }): Promise<SelectedWakeUp> {
  if (options.name === "in_process") {
    return {
      adapter: new InProcessWakeUpAdapter(),
      capability: {
        adapter: "in_process",
        crossesProcesses: false,
        reason: "in-process signalling was requested",
      },
    }
  }
  if (options.name === "postgresql") {
    return {
      adapter: notificationAdapter(options.database),
      capability: {
        adapter: "postgresql_notify",
        crossesProcesses: true,
        measuredFloorMilliseconds: POSTGRESQL_FLOOR_MILLISECONDS,
        reason: "PostgreSQL LISTEN was requested",
      },
    }
  }
  if (options.name === "redis") {
    return await redisSelection({
      url: requiredRedisUrl(options),
      reason: "Redis was requested",
    })
  }
  throw new TypeError(
    `unknown wakeUp ${JSON.stringify(options.name)}, expected one of ${WAKE_UP_NAMES.join(", ")} or an adapter`,
  )
}

async function automatic(options: WakeUpSelectionOptions): Promise<SelectedWakeUp> {
  const url = redisUrl(options)
  if (url !== undefined) {
    return await redisSelection({
      url,
      reason: `${REDIS_URL_VARIABLE} is set, so Redis carries the signal between processes`,
    })
  }
  if (options.database.family !== "postgresql" || !options.database.wakeUp) {
    return polling({
      options,
      reason: `${options.database.family} has no notification channel and ${REDIS_URL_VARIABLE} is not set`,
    })
  }
  return await postgresqlSelection(options)
}

async function postgresqlSelection(options: WakeUpSelectionOptions): Promise<SelectedWakeUp> {
  if (!(await notificationsDeliver(options))) return pooled(options)
  return {
    adapter: notificationAdapter(options.database),
    capability: {
      adapter: "postgresql_notify",
      crossesProcesses: true,
      measuredFloorMilliseconds: POSTGRESQL_FLOOR_MILLISECONDS,
      reason:
        "a probe notification arrived, so PostgreSQL LISTEN carries the signal between processes",
    },
  }
}

async function notificationsDeliver(options: WakeUpSelectionOptions): Promise<boolean> {
  const probe = notificationAdapter(options.database, { channelPrefix: PROBE_CHANNEL_PREFIX })
  try {
    const watch = await probe.watch(PROBE_ROLE)
    await options.database.connection((connection) =>
      connection.run("SELECT pg_notify(?, ?)", [probe.channelFor(PROBE_ROLE), PROBE_ROLE]),
    )
    const timeoutMilliseconds = options.probeTimeoutMilliseconds ?? PROBE_TIMEOUT_MILLISECONDS
    return (await watch.wait({ timeoutMilliseconds })) === true
  } catch {
    return false
  } finally {
    await closeQuietly(probe)
  }
}

function pooled(options: WakeUpSelectionOptions): SelectedWakeUp {
  options.logger.warn({
    event: "solid_objects.wake_up.pooled_session",
    reason:
      "PostgreSQL notifications were not selected because a probe notification did not arrive",
  })
  return polling({
    options,
    reason:
      "a probe notification did not arrive, so LISTEN cannot carry the signal between processes; " +
      "a transaction pooler such as PgBouncer is the usual cause",
  })
}

function polling(input: { options: WakeUpSelectionOptions; reason: string }): SelectedWakeUp {
  return {
    adapter: new InProcessWakeUpAdapter(),
    capability: {
      adapter: "polling",
      crossesProcesses: false,
      measuredFloorMilliseconds: input.options.idlePollingIntervalMilliseconds,
      reason: input.reason,
    },
  }
}

async function redisSelection(input: { url: string; reason: string }): Promise<SelectedWakeUp> {
  const { RedisWakeUpAdapter } = await importRedis()
  return {
    adapter: new RedisWakeUpAdapter({ url: input.url }),
    capability: {
      adapter: "redis",
      crossesProcesses: true,
      measuredFloorMilliseconds: REDIS_FLOOR_MILLISECONDS,
      reason: input.reason,
    },
  }
}

async function importRedis(): Promise<typeof import("./wake-up/redis.js")> {
  try {
    return await import("./wake-up/redis.js")
  } catch (error) {
    throw new TypeError("the redis package is required for the Redis wake-up adapter", {
      cause: error,
    })
  }
}

function notificationAdapter(
  database: Database,
  options: { channelPrefix?: string } = {},
): NotificationWakeUpAdapter {
  if (!database.wakeUp) {
    throw new TypeError(`the ${database.family} database does not provide a notification channel`)
  }
  return database.wakeUp(options)
}

function redisUrl(options: WakeUpSelectionOptions): string | undefined {
  const value = options.redisUrl ?? process.env[REDIS_URL_VARIABLE]
  if (value === undefined || value.length === 0) return undefined
  return value
}

function requiredRedisUrl(options: WakeUpSelectionOptions): string {
  const url = redisUrl(options)
  if (url === undefined) {
    throw new TypeError(`wakeUp "redis" requires ${REDIS_URL_VARIABLE} or an explicit adapter`)
  }
  return url
}

async function closeQuietly(adapter: WakeUpAdapter): Promise<void> {
  try {
    await adapter.close()
  } catch {
    return
  }
}

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

type NotificationAdapterFactory = (options?: {
  channelPrefix?: string
}) => NotificationWakeUpAdapter

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
  if (adapter.defaultCapability) return { adapter, capability: adapter.defaultCapability }
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
  if (options.name === "postgresql") return requestedPostgresql(options)
  if (options.name === "redis") return await requestedRedis(options)

  throw new TypeError(
    `unknown wakeUp ${JSON.stringify(options.name)}, expected one of ${WAKE_UP_NAMES.join(", ")} or an adapter`,
  )
}

function requestedPostgresql(options: WakeUpSelectionOptions): SelectedWakeUp {
  const wakeUp = notificationFactory(options.database)
  if (!wakeUp) {
    return unavailable({
      options,
      reason:
        `wakeUp "postgresql" needs a database with a notification channel, ` +
        `and ${options.database.family} provides none`,
    })
  }
  return {
    adapter: wakeUp(),
    capability: {
      adapter: "postgresql_notify",
      crossesProcesses: true,
      measuredFloorMilliseconds: POSTGRESQL_FLOOR_MILLISECONDS,
      reason: "PostgreSQL LISTEN was requested",
    },
  }
}

async function requestedRedis(options: WakeUpSelectionOptions): Promise<SelectedWakeUp> {
  const url = redisUrl(options)
  if (url === undefined) {
    return unavailable({
      options,
      reason: `wakeUp "redis" needs ${REDIS_URL_VARIABLE}, which is not set`,
    })
  }
  return await redisSelection({ options, url, reason: "Redis was requested" })
}

async function automatic(options: WakeUpSelectionOptions): Promise<SelectedWakeUp> {
  const url = redisUrl(options)
  if (url !== undefined) {
    return await redisSelection({
      options,
      url,
      reason: `${REDIS_URL_VARIABLE} is set, so Redis carries the signal between processes`,
    })
  }
  const wakeUp = notificationFactory(options.database)
  if (options.database.family !== "postgresql" || !wakeUp) {
    return polling({
      idlePollingIntervalMilliseconds: options.idlePollingIntervalMilliseconds,
      reason: `${options.database.family} has no notification channel and ${REDIS_URL_VARIABLE} is not set`,
    })
  }
  return await postgresqlSelection({ options, wakeUp })
}

async function postgresqlSelection(input: {
  options: WakeUpSelectionOptions
  wakeUp: NotificationAdapterFactory
}): Promise<SelectedWakeUp> {
  if (!(await notificationsDeliver(input))) return pooled(input.options)
  return {
    adapter: input.wakeUp(),
    capability: {
      adapter: "postgresql_notify",
      crossesProcesses: true,
      measuredFloorMilliseconds: POSTGRESQL_FLOOR_MILLISECONDS,
      reason:
        "a probe notification arrived, so PostgreSQL LISTEN carries the signal between processes",
    },
  }
}

async function notificationsDeliver(input: {
  options: WakeUpSelectionOptions
  wakeUp: NotificationAdapterFactory
}): Promise<boolean> {
  const probe = input.wakeUp({ channelPrefix: PROBE_CHANNEL_PREFIX })
  try {
    const watch = await probe.watch(PROBE_ROLE)
    await input.options.database.connection((connection) =>
      connection.run("SELECT pg_notify(?, ?)", [probe.channelFor(PROBE_ROLE), PROBE_ROLE]),
    )
    const timeoutMilliseconds = input.options.probeTimeoutMilliseconds ?? PROBE_TIMEOUT_MILLISECONDS
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
    idlePollingIntervalMilliseconds: options.idlePollingIntervalMilliseconds,
    reason:
      "a probe notification did not arrive, so LISTEN cannot carry the signal between processes; " +
      "a transaction pooler such as PgBouncer is the usual cause",
  })
}

function unavailable(input: { options: WakeUpSelectionOptions; reason: string }): SelectedWakeUp {
  input.options.logger.warn({ event: "solid_objects.wake_up.unavailable", reason: input.reason })
  return polling({
    idlePollingIntervalMilliseconds: input.options.idlePollingIntervalMilliseconds,
    reason: input.reason,
  })
}

function polling(input: {
  idlePollingIntervalMilliseconds: number
  reason: string
}): SelectedWakeUp {
  return {
    adapter: new InProcessWakeUpAdapter(),
    capability: {
      adapter: "polling",
      crossesProcesses: false,
      measuredFloorMilliseconds: input.idlePollingIntervalMilliseconds,
      reason: input.reason,
    },
  }
}

async function redisSelection(input: {
  options: WakeUpSelectionOptions
  url: string
  reason: string
}): Promise<SelectedWakeUp> {
  const redis = await importRedis()
  if (!redis) {
    return unavailable({
      options: input.options,
      reason: `${REDIS_URL_VARIABLE} is set, and the redis package is not installed`,
    })
  }
  return {
    adapter: new redis.RedisWakeUpAdapter({ url: input.url }),
    capability: {
      adapter: "redis",
      crossesProcesses: true,
      measuredFloorMilliseconds: REDIS_FLOOR_MILLISECONDS,
      reason: input.reason,
    },
  }
}

async function importRedis(): Promise<typeof import("./wake-up/redis.js") | undefined> {
  try {
    return await import("./wake-up/redis.js")
  } catch {
    return undefined
  }
}

function notificationFactory(database: Database): NotificationAdapterFactory | undefined {
  const wakeUp = database.wakeUp
  if (!wakeUp) return undefined
  return (options) => wakeUp.call(database, options)
}

function redisUrl(options: WakeUpSelectionOptions): string | undefined {
  const value = options.redisUrl ?? environmentRedisUrl()
  if (value === undefined || value.length === 0) return undefined
  return value
}

function environmentRedisUrl(): string | undefined {
  return globalThis.process?.env?.[REDIS_URL_VARIABLE]
}

async function closeQuietly(adapter: WakeUpAdapter): Promise<void> {
  try {
    await adapter.close()
  } catch {
    return
  }
}

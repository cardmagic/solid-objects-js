import { createClient, type RedisClientType } from "redis"
import {
  InProcessWakeUpAdapter,
  type WakeUpAdapter,
  type WakeUpRole,
  type WakeUpWatch,
} from "../wake-up.js"

const ROLES = [
  "actors",
  "effects",
  "reminders",
  "broadcasts",
] as const satisfies readonly WakeUpRole[]

export interface RedisWakeUpFailure {
  operation: "connect" | "subscribe" | "publish" | "connection"
  error: Error
}

export interface RedisWakeUpOptions {
  url: string
  channelPrefix?: string
  connectionTimeoutMilliseconds?: number
  onError?: (failure: RedisWakeUpFailure) => void
}

export class RedisWakeUpAdapter implements WakeUpAdapter {
  private readonly local = new InProcessWakeUpAdapter()
  private readonly publisher: RedisClientType
  private readonly subscriber: RedisClientType
  private readonly channels = new Map<WakeUpRole, string>()
  private readonly subscriptions = new Map<WakeUpRole, Promise<void>>()
  private readonly connectionTimeoutMilliseconds: number
  private readonly onError: (failure: RedisWakeUpFailure) => void
  private publisherConnection: Promise<void> | undefined
  private subscriberConnection: Promise<void> | undefined
  private closed = false

  constructor(options: RedisWakeUpOptions) {
    if (options.url.length === 0) throw new TypeError("Redis wake-up url must not be empty")
    const channelPrefix = options.channelPrefix ?? "solid_objects"
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channelPrefix)) {
      throw new TypeError(
        "Redis wake-up channelPrefix must contain only letters, digits, and underscores",
      )
    }
    const connectionTimeoutMilliseconds = options.connectionTimeoutMilliseconds ?? 1_000
    if (!Number.isFinite(connectionTimeoutMilliseconds) || connectionTimeoutMilliseconds <= 0) {
      throw new TypeError("Redis wake-up connectionTimeoutMilliseconds must be positive")
    }
    this.connectionTimeoutMilliseconds = connectionTimeoutMilliseconds
    for (const role of ROLES) this.channels.set(role, `${channelPrefix}:${role}`)
    this.publisher = createClient({
      url: options.url,
      socket: { connectTimeout: connectionTimeoutMilliseconds },
    })
    this.subscriber = this.publisher.duplicate()
    this.onError =
      options.onError ??
      ((failure) =>
        console.error({
          event: "solid_objects.redis_wake_up.failed",
          operation: failure.operation,
          errorName: failure.error.name,
        }))
    this.publisher.on("error", (error) => this.report("connection", error))
    this.subscriber.on("error", (error) => this.report("connection", error))
  }

  async watch(role: WakeUpRole): Promise<WakeUpWatch> {
    if (!this.closed) {
      await this.withTimeout(this.ensureSubscribed(role)).catch((error: unknown) => {
        this.report("subscribe", error)
      })
    }
    return this.local.watch(role)
  }

  async notify(role: WakeUpRole): Promise<void> {
    if (this.closed) return
    try {
      await this.withTimeout(this.ensurePublisher())
      await this.publisher.publish(this.channel(role), role)
    } catch (error) {
      this.report("publish", error)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.local.close()
    if (this.publisher.isOpen) this.publisher.destroy()
    if (this.subscriber.isOpen) this.subscriber.destroy()
  }

  private ensurePublisher(): Promise<void> {
    if (this.publisher.isReady) return Promise.resolve()
    if (this.publisherConnection) return this.publisherConnection
    const connection = this.publisher.connect().then(() => undefined)
    this.publisherConnection = connection
    void connection
      .catch((error: unknown) => this.report("connect", error))
      .finally(() => {
        if (this.publisherConnection === connection) this.publisherConnection = undefined
      })
    return connection
  }

  private ensureSubscriber(): Promise<void> {
    if (this.subscriber.isReady) return Promise.resolve()
    if (this.subscriberConnection) return this.subscriberConnection
    const connection = this.subscriber.connect().then(() => undefined)
    this.subscriberConnection = connection
    void connection
      .catch((error: unknown) => this.report("connect", error))
      .finally(() => {
        if (this.subscriberConnection === connection) this.subscriberConnection = undefined
      })
    return connection
  }

  private ensureSubscribed(role: WakeUpRole): Promise<void> {
    const existing = this.subscriptions.get(role)
    if (existing) return existing
    const subscription = this.ensureSubscriber().then(() =>
      this.subscriber.subscribe(this.channel(role), () => this.local.notify(role)),
    )
    this.subscriptions.set(role, subscription)
    void subscription.catch(() => {
      if (this.subscriptions.get(role) === subscription) this.subscriptions.delete(role)
    })
    return subscription
  }

  private withTimeout<Result>(operation: Promise<Result>): Promise<Result> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Redis wake-up connection timed out")),
        this.connectionTimeoutMilliseconds,
      )
      void operation.then(
        (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        (error: unknown) => {
          clearTimeout(timeout)
          reject(error)
        },
      )
    })
  }

  private channel(role: WakeUpRole): string {
    const channel = this.channels.get(role)
    if (!channel) throw new TypeError(`unknown wake-up role ${role}`)
    return channel
  }

  private report(operation: RedisWakeUpFailure["operation"], error: unknown): void {
    try {
      this.onError({
        operation,
        error: error instanceof Error ? error : new Error("Redis wake-up failed"),
      })
    } catch {}
  }
}

export function redisWakeUp(options: RedisWakeUpOptions): RedisWakeUpAdapter {
  return new RedisWakeUpAdapter(options)
}

import { Client, type ClientConfig, type Notification } from "pg"
import type { WakeUpAdapter, WakeUpRole, WakeUpWatch } from "../wake-up.js"

const ROLES = [
  "actors",
  "effects",
  "reminders",
  "broadcasts",
] as const satisfies readonly WakeUpRole[]

export interface PostgreSQLWakeUpFailure {
  operation: "connect" | "listen" | "connection"
  error: Error
}

export interface PostgreSQLWakeUpOptions {
  connectionString: string
  channelPrefix?: string
  applicationName?: string
  onListenerError?: (failure: PostgreSQLWakeUpFailure) => void
}

export class PostgreSQLWakeUpAdapter implements WakeUpAdapter {
  private readonly clientConfiguration: ClientConfig
  private readonly channels = new Map<WakeUpRole, string>()
  private readonly rolesByChannel = new Map<string, WakeUpRole>()
  private readonly generations = new Map<WakeUpRole, number>()
  private readonly waiters = new Map<WakeUpRole, Set<(notified: boolean) => void>>()
  private readonly listenedRoles = new Set<WakeUpRole>()
  private readonly listening = new Map<WakeUpRole, Promise<void>>()
  private readonly onListenerError: (failure: PostgreSQLWakeUpFailure) => void
  private client: Client | undefined
  private connecting: Promise<Client> | undefined
  private closed = false

  constructor(options: PostgreSQLWakeUpOptions) {
    if (options.connectionString.length === 0) {
      throw new TypeError("PostgreSQL wake-up connectionString must not be empty")
    }
    const channelPrefix = options.channelPrefix ?? "solid_objects"
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channelPrefix)) {
      throw new TypeError(
        "PostgreSQL wake-up channelPrefix must contain only letters, digits, and underscores",
      )
    }
    for (const role of ROLES) {
      const channel = `${channelPrefix}_${role}`
      if (Buffer.byteLength(channel) > 63) {
        throw new TypeError("PostgreSQL wake-up channel names must not exceed 63 bytes")
      }
      this.channels.set(role, channel)
      this.rolesByChannel.set(channel, role)
    }
    this.clientConfiguration = {
      connectionString: options.connectionString,
      application_name: options.applicationName ?? "solid-objects-wake-up",
    }
    this.onListenerError =
      options.onListenerError ??
      ((failure) =>
        console.error({
          event: "solid_objects.postgresql_wake_up.failed",
          operation: failure.operation,
          errorName: failure.error.name,
        }))
  }

  async watch(role: WakeUpRole): Promise<WakeUpWatch> {
    await this.ensureListening(role)
    const generation = this.generation(role)
    return {
      wait: (options) => this.wait({ role, generation, ...options }),
    }
  }

  async notify(role: WakeUpRole): Promise<void> {
    if (this.closed) return
    const client = await this.connectedClient()
    await client.query("SELECT pg_notify($1, $2)", [this.channel(role), role])
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.wakeEveryRole()
    const connecting = this.connecting
    const client = this.client
    this.client = undefined
    this.connecting = undefined
    if (client) {
      await client.end().catch((error: unknown) => this.reportFailure("connection", error))
      return
    }
    if (!connecting) return
    const connected = await connecting.catch(() => undefined)
    await connected?.end().catch((error: unknown) => this.reportFailure("connection", error))
  }

  private async ensureListening(role: WakeUpRole): Promise<void> {
    if (this.closed || this.listenedRoles.has(role)) return
    const existing = this.listening.get(role)
    if (existing) {
      await existing
      return
    }
    const listening = this.listen(role)
    this.listening.set(role, listening)
    try {
      await listening
    } finally {
      if (this.listening.get(role) === listening) this.listening.delete(role)
    }
  }

  private async listen(role: WakeUpRole): Promise<void> {
    let client: Client
    try {
      client = await this.connectedClient()
    } catch (error) {
      this.reportFailure("connect", error)
      return
    }
    try {
      await client.query(`LISTEN "${this.channel(role)}"`)
      if (this.client === client) this.listenedRoles.add(role)
    } catch (error) {
      this.reportFailure("listen", error)
    }
  }

  private async connectedClient(): Promise<Client> {
    if (this.closed) throw new Error("PostgreSQL wake-up adapter is closed")
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    const client = new Client(this.clientConfiguration)
    client.on("notification", (notification) => this.receive(notification))
    client.on("error", (error) => this.connectionFailed(client, error))
    client.on("end", () => this.connectionEnded(client))
    const connecting = client.connect().then(() => {
      if (this.closed) throw new Error("PostgreSQL wake-up adapter is closed")
      this.client = client
      return client
    })
    this.connecting = connecting
    try {
      return await connecting
    } catch (error) {
      await client.end().catch(() => undefined)
      throw error
    } finally {
      if (this.connecting === connecting) this.connecting = undefined
    }
  }

  private connectionFailed(client: Client, error: Error): void {
    if (this.client !== client || this.closed) return
    this.client = undefined
    this.listenedRoles.clear()
    this.listening.clear()
    this.reportFailure("connection", error)
    this.wakeEveryRole()
  }

  private connectionEnded(client: Client): void {
    if (this.client !== client || this.closed) return
    this.client = undefined
    this.listenedRoles.clear()
    this.listening.clear()
    this.reportFailure("connection", new Error("PostgreSQL wake-up connection ended"))
    this.wakeEveryRole()
  }

  private receive(notification: Notification): void {
    const role = this.rolesByChannel.get(notification.channel)
    if (!role) return
    this.wake(role)
  }

  private wait(options: {
    role: WakeUpRole
    generation: number
    timeoutMilliseconds: number
    signal?: AbortSignal
  }): Promise<boolean> {
    if (this.closed || options.signal?.aborted) return Promise.resolve(false)
    if (this.generation(options.role) !== options.generation) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const waiters = this.waiters.get(options.role) ?? new Set()
      const finish = (notified: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        waiters.delete(finish)
        if (waiters.size === 0) this.waiters.delete(options.role)
        options.signal?.removeEventListener("abort", abort)
        resolve(notified)
      }
      const abort = () => finish(false)
      const timeout = setTimeout(() => finish(false), options.timeoutMilliseconds)
      waiters.add(finish)
      this.waiters.set(options.role, waiters)
      options.signal?.addEventListener("abort", abort, { once: true })
      if (
        this.closed ||
        options.signal?.aborted ||
        this.generation(options.role) !== options.generation
      ) {
        finish(!this.closed && !options.signal?.aborted)
      }
    })
  }

  private wake(role: WakeUpRole, notified = true): void {
    this.generations.set(role, this.generation(role) + 1)
    const waiters = this.waiters.get(role)
    if (!waiters) return
    this.waiters.delete(role)
    for (const finish of waiters) finish(notified)
  }

  private wakeEveryRole(): void {
    for (const role of ROLES) this.wake(role, false)
  }

  private generation(role: WakeUpRole): number {
    return this.generations.get(role) ?? 0
  }

  private channel(role: WakeUpRole): string {
    const channel = this.channels.get(role)
    if (!channel) throw new TypeError(`unknown wake-up role ${role}`)
    return channel
  }

  private reportFailure(operation: PostgreSQLWakeUpFailure["operation"], error: unknown): void {
    try {
      this.onListenerError({
        operation,
        error: error instanceof Error ? error : new Error("PostgreSQL wake-up failed"),
      })
    } catch {}
  }
}

export function postgresqlWakeUp(options: PostgreSQLWakeUpOptions): PostgreSQLWakeUpAdapter {
  return new PostgreSQLWakeUpAdapter(options)
}

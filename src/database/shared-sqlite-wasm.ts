import { randomUUID } from "../platform/uuid.js"
import { requireWebLocks } from "../platform/web-locks.js"
import { DatabaseDeadlineExceeded } from "../errors.js"
import { requireDatabaseDeadlineRemaining } from "./deadline.js"
import { databaseTransactionActive, withDatabaseTransaction } from "./transaction-context.js"
import { sqliteWasm, type SQLiteWasmDatabase } from "./sqlite-wasm.js"
import type { Database, DatabaseConnection, RunResult } from "./types.js"

const PROTOCOL = "solid-objects-shared-sqlite"
const VERSION = 1
const NAME_PREFIX = "solid-objects:shared-sqlite:"

export interface SharedSQLiteWasmDatabaseOptions {
  path: string
  name?: string
  storage?: "temporary" | "persistent"
  requestTimeoutMilliseconds?: number
  retryIntervalMilliseconds?: number
  sessionIdleTimeoutMilliseconds?: number
  openAttempts?: number
  onError?: (error: Error) => void
}

export class SharedDatabaseFailover extends Error {
  constructor() {
    super("the shared SQLite database failed over; retry the operation")
    this.name = "SharedDatabaseFailover"
  }
}

export class SharedDatabaseUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SharedDatabaseUnavailable"
  }
}

type SessionMode = "connection" | "transaction"
type StatementOperation = "run" | "get" | "all" | "now"
type CloseOutcome = "commit" | "rollback" | "end"

interface Envelope {
  protocol: typeof PROTOCOL
  version: typeof VERSION
}

interface PingMessage extends Envelope {
  kind: "ping"
  requestId: string
}

interface PongMessage extends Envelope {
  kind: "pong"
  requestId: string
  epoch: string
}

interface HolderOnlineMessage extends Envelope {
  kind: "holder-online"
  epoch: string
}

interface OpenMessage extends Envelope {
  kind: "open"
  requestId: string
  epoch: string
  sessionId: string
  mode: SessionMode
}

interface StatementMessage extends Envelope {
  kind: "statement"
  requestId: string
  epoch: string
  sessionId: string
  operation: StatementOperation
  sql: string
  parameters: readonly unknown[]
}

interface CloseSessionMessage extends Envelope {
  kind: "close"
  requestId: string
  epoch: string
  sessionId: string
  outcome: CloseOutcome
}

interface ResultMessage extends Envelope {
  kind: "result"
  requestId: string
  outcome: { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } }
}

type SharedMessage =
  | PingMessage
  | PongMessage
  | HolderOnlineMessage
  | OpenMessage
  | StatementMessage
  | CloseSessionMessage
  | ResultMessage

class SessionOpenRejected extends Error {
  constructor(readonly reason: Error) {
    super(reason.message)
    this.name = "SessionOpenRejected"
  }
}

class RollbackSignal extends Error {
  constructor() {
    super("rollback requested")
    this.name = "RollbackSignal"
  }
}

interface PendingRequest {
  epoch: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface HolderSession {
  connection?: DatabaseConnection
  finishResolve: () => void
  finishReject: (error: Error) => void
  settled: Promise<unknown>
  watchdog?: ReturnType<typeof setTimeout>
}

export function sharedSqliteWasm(
  options: SharedSQLiteWasmDatabaseOptions,
): SharedSQLiteWasmDatabase {
  return new SharedSQLiteWasmDatabase(options)
}

export class SharedSQLiteWasmDatabase implements Database {
  readonly family = "sqlite" as const
  readonly schemaIdentity = "solid-objects-wasm-v1"
  private readonly options: SharedSQLiteWasmDatabaseOptions
  private readonly channel: BroadcastChannel
  private readonly electionAbort = new AbortController()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly holderSessions = new Map<string, HolderSession>()
  private readonly epochWaiters: Array<(epoch: string) => void> = []
  private readonly electionLoop: Promise<void>
  private roleValue: "connecting" | "holder" | "remote" = "connecting"
  private currentEpoch: string | undefined
  private underlying: SQLiteWasmDatabase | undefined
  private releaseHold: (() => void) | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(options: SharedSQLiteWasmDatabaseOptions) {
    this.options = options
    this.channel = new BroadcastChannel(`${NAME_PREFIX}${this.electionName()}`)
    this.channel.onmessage = (event: MessageEvent) => {
      const message = parseSharedMessage(event.data)
      if (message) void this.receive(message)
    }
    this.pingTimer = setInterval(() => {
      if (this.currentEpoch !== undefined || this.roleValue === "holder") {
        this.stopPinging()
        return
      }
      this.post({ ...envelope(), kind: "ping", requestId: randomUUID() })
    }, this.retryIntervalMilliseconds())
    this.electionLoop = this.runElection()
  }

  role(): "connecting" | "holder" | "remote" {
    return this.roleValue
  }

  async connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.dispatchSession({ mode: "connection", callback })
  }

  async transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return withDatabaseTransaction(this, () =>
      this.dispatchSession({ mode: "transaction", callback }),
    )
  }

  private async dispatchSession<Result>(input: {
    mode: SessionMode
    callback: (connection: DatabaseConnection) => Promise<Result>
  }): Promise<Result> {
    const attempts = 3
    for (let attempt = 0; ; attempt += 1) {
      if (this.roleValue === "holder" && this.underlying) {
        return input.mode === "transaction"
          ? this.underlying.transaction(input.callback)
          : this.underlying.connection(input.callback)
      }
      try {
        return await this.remoteSession(input)
      } catch (error) {
        if (!(error instanceof SessionOpenRejected)) throw error
        if (attempt >= attempts - 1) throw error.reason
        requireDatabaseDeadlineRemaining()
        await delay(this.retryIntervalMilliseconds())
      }
    }
  }

  transactionActive(): boolean {
    return databaseTransactionActive(this)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopPinging()
    this.electionAbort.abort()
    this.releaseHold?.()
    this.rejectInFlight(new SharedDatabaseUnavailable("the shared SQLite database is closed"))
    await this.electionLoop.catch(() => undefined)
    this.channel.onmessage = null
    this.channel.close()
  }

  private async remoteSession<Result>(input: {
    mode: SessionMode
    callback: (connection: DatabaseConnection) => Promise<Result>
  }): Promise<Result> {
    const initialRemaining = requireDatabaseDeadlineRemaining()
    const deadlineExpiresAtMilliseconds =
      initialRemaining === undefined ? undefined : performance.now() + initialRemaining
    const epoch = await this.requireEpoch().catch((error: Error) => {
      throw new SessionOpenRejected(error)
    })
    const sessionId = randomUUID()
    await this.request({
      ...envelope(),
      kind: "open",
      requestId: randomUUID(),
      epoch,
      sessionId,
      mode: input.mode,
    }).catch((error: Error) => {
      throw new SessionOpenRejected(error)
    })
    const connection = new SharedRemoteConnection({
      database: this,
      sessionId,
      epoch,
      deadlineExpiresAtMilliseconds,
    })
    try {
      const result = await input.callback(connection)
      requireDatabaseDeadlineRemaining()
      requireCapturedDeadline(deadlineExpiresAtMilliseconds)
      await this.request({
        ...envelope(),
        kind: "close",
        requestId: randomUUID(),
        epoch,
        sessionId,
        outcome: input.mode === "transaction" ? "commit" : "end",
      })
      return result
    } catch (error) {
      await this.request({
        ...envelope(),
        kind: "close",
        requestId: randomUUID(),
        epoch,
        sessionId,
        outcome: input.mode === "transaction" ? "rollback" : "end",
      }).catch(() => undefined)
      throw error
    }
  }

  sendStatement(input: {
    sessionId: string
    epoch: string
    operation: StatementOperation
    sql: string
    parameters: readonly unknown[]
  }): Promise<unknown> {
    return this.request({
      ...envelope(),
      kind: "statement",
      requestId: randomUUID(),
      epoch: input.epoch,
      sessionId: input.sessionId,
      operation: input.operation,
      sql: input.sql,
      parameters: input.parameters,
    })
  }

  private request(message: OpenMessage | StatementMessage | CloseSessionMessage): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new SharedDatabaseUnavailable("the shared SQLite database is closed"))
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId)
        reject(
          new SharedDatabaseUnavailable(
            `no shared SQLite database holder answered within ${this.requestTimeoutMilliseconds()}ms`,
          ),
        )
      }, this.requestTimeoutMilliseconds())
      this.pending.set(message.requestId, { epoch: message.epoch, resolve, reject, timer })
      this.post(message)
    })
  }

  private async requireEpoch(): Promise<string> {
    if (this.currentEpoch !== undefined) return this.currentEpoch
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.epochWaiters.indexOf(waiter)
        if (index >= 0) this.epochWaiters.splice(index, 1)
        reject(
          new SharedDatabaseUnavailable(
            `no shared SQLite database holder announced within ${this.requestTimeoutMilliseconds()}ms`,
          ),
        )
      }, this.requestTimeoutMilliseconds())
      const waiter = (epoch: string) => {
        clearTimeout(timer)
        resolve(epoch)
      }
      this.epochWaiters.push(waiter)
    })
  }

  private adoptEpoch(epoch: string): void {
    if (this.currentEpoch === epoch) return
    if (this.currentEpoch !== undefined) this.rejectInFlight(new SharedDatabaseFailover())
    this.currentEpoch = epoch
    if (this.roleValue !== "holder") this.roleValue = "remote"
    this.stopPinging()
    for (const waiter of this.epochWaiters.splice(0)) waiter(epoch)
  }

  private rejectInFlight(error: Error): void {
    for (const [requestId, entry] of [...this.pending]) {
      this.pending.delete(requestId)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  private async receive(message: SharedMessage): Promise<void> {
    if (message.kind === "result") {
      const entry = this.pending.get(message.requestId)
      if (!entry) return
      this.pending.delete(message.requestId)
      clearTimeout(entry.timer)
      if (message.outcome.ok) entry.resolve(message.outcome.value)
      else entry.reject(rebuildError(message.outcome.error))
      return
    }
    if (message.kind === "holder-online" || message.kind === "pong") {
      if (this.roleValue !== "holder") this.adoptEpoch(message.epoch)
      return
    }
    if (this.roleValue !== "holder" || this.currentEpoch === undefined) return
    if (message.kind === "ping") {
      this.post({
        ...envelope(),
        kind: "pong",
        requestId: message.requestId,
        epoch: this.currentEpoch,
      })
      return
    }
    if (message.epoch !== this.currentEpoch) {
      this.respond(message.requestId, {
        ok: false,
        error: describeError(new SharedDatabaseFailover()),
      })
      return
    }
    if (message.kind === "open") await this.handleOpen(message)
    else if (message.kind === "statement") await this.handleStatement(message)
    else await this.handleClose(message)
  }

  private async handleOpen(message: OpenMessage): Promise<void> {
    const underlying = this.underlying
    if (!underlying) return
    let finishResolve = () => {}
    let finishReject: (error: Error) => void = () => {}
    const done = new Promise<void>((resolve, reject) => {
      finishResolve = resolve
      finishReject = reject
    })
    let ready: (session: HolderSession) => void = () => {}
    const acquired = new Promise<HolderSession>((resolve) => {
      ready = resolve
    })
    const runner =
      message.mode === "transaction"
        ? underlying.transaction.bind(underlying)
        : underlying.connection.bind(underlying)
    const session: HolderSession = {
      finishResolve,
      finishReject,
      settled: runner(async (connection) => {
        session.connection = connection
        ready(session)
        await done
        return null
      }),
    }
    session.settled.catch(() => undefined)
    this.holderSessions.set(message.sessionId, session)
    await acquired
    this.touchSession(message.sessionId)
    this.respond(message.requestId, { ok: true, value: null })
  }

  private async handleStatement(message: StatementMessage): Promise<void> {
    const session = this.holderSessions.get(message.sessionId)
    if (!session?.connection) {
      this.respond(message.requestId, {
        ok: false,
        error: describeError(new SharedDatabaseFailover()),
      })
      return
    }
    this.touchSession(message.sessionId)
    try {
      const value = await executeStatement({ connection: session.connection, message })
      this.respond(message.requestId, { ok: true, value })
    } catch (error) {
      this.respond(message.requestId, { ok: false, error: describeError(error) })
    }
  }

  private async handleClose(message: CloseSessionMessage): Promise<void> {
    const session = this.holderSessions.get(message.sessionId)
    if (!session) {
      this.respond(message.requestId, { ok: true, value: null })
      return
    }
    this.dropSession(message.sessionId)
    if (message.outcome === "rollback") {
      session.finishReject(new RollbackSignal())
      await session.settled.catch(() => undefined)
      this.respond(message.requestId, { ok: true, value: null })
      return
    }
    session.finishResolve()
    try {
      await session.settled
      this.respond(message.requestId, { ok: true, value: null })
    } catch (error) {
      this.respond(message.requestId, { ok: false, error: describeError(error) })
    }
  }

  private touchSession(sessionId: string): void {
    const session = this.holderSessions.get(sessionId)
    if (!session) return
    if (session.watchdog) clearTimeout(session.watchdog)
    session.watchdog = setTimeout(() => {
      this.dropSession(sessionId)
      session.finishReject(
        new SharedDatabaseUnavailable("the shared SQLite session timed out while idle"),
      )
    }, this.sessionIdleTimeoutMilliseconds())
  }

  private dropSession(sessionId: string): void {
    const session = this.holderSessions.get(sessionId)
    if (!session) return
    if (session.watchdog) clearTimeout(session.watchdog)
    this.holderSessions.delete(sessionId)
  }

  private async runElection(): Promise<void> {
    try {
      requireWebLocks()
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      return
    }
    while (!this.closed) {
      try {
        await requireWebLocks().request(
          `${NAME_PREFIX}${this.electionName()}`,
          { signal: this.electionAbort.signal },
          () => this.serveAsHolder(),
        )
        return
      } catch (error) {
        if (this.closed || this.electionAbort.signal.aborted) return
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
        await delay(this.retryIntervalMilliseconds())
      }
    }
  }

  private async serveAsHolder(): Promise<void> {
    if (this.closed) return
    const underlying = await this.openUnderlyingWithRetry()
    if (this.closed) {
      await underlying.close()
      return
    }
    this.underlying = underlying
    this.roleValue = "holder"
    this.stopPinging()
    const epoch = randomUUID()
    this.rejectInFlight(new SharedDatabaseFailover())
    this.currentEpoch = epoch
    for (const waiter of this.epochWaiters.splice(0)) waiter(epoch)
    this.post({ ...envelope(), kind: "holder-online", epoch })
    await new Promise<void>((resolve) => {
      this.releaseHold = resolve
      if (this.closed) resolve()
    })
    for (const sessionId of [...this.holderSessions.keys()]) {
      const session = this.holderSessions.get(sessionId)
      this.dropSession(sessionId)
      session?.finishReject(
        new SharedDatabaseUnavailable("the shared SQLite database holder is closed"),
      )
      await session?.settled.catch(() => undefined)
    }
    await underlying.close()
  }

  private async openUnderlyingWithRetry(): Promise<SQLiteWasmDatabase> {
    const attempts = this.options.openAttempts ?? 50
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.closed) break
      try {
        return await sqliteWasm({ path: this.options.path, storage: this.storageMode() })
      } catch (error) {
        lastError = error
        await delay(100)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new SharedDatabaseUnavailable("the shared SQLite pool could not be opened")
  }

  private respond(requestId: string, outcome: ResultMessage["outcome"]): void {
    this.post({ ...envelope(), kind: "result", requestId, outcome })
  }

  private post(message: SharedMessage): void {
    if (this.closed) return
    this.channel.postMessage(message)
    queueMicrotask(() => {
      void this.receive(message)
    })
  }

  private stopPinging(): void {
    if (this.pingTimer === undefined) return
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private electionName(): string {
    return this.options.name ?? this.options.path
  }

  private storageMode(): "temporary" | "persistent" {
    return this.options.storage ?? (this.options.path === ":memory:" ? "temporary" : "persistent")
  }

  private requestTimeoutMilliseconds(): number {
    return this.options.requestTimeoutMilliseconds ?? 15_000
  }

  private retryIntervalMilliseconds(): number {
    return this.options.retryIntervalMilliseconds ?? 200
  }

  private sessionIdleTimeoutMilliseconds(): number {
    return this.options.sessionIdleTimeoutMilliseconds ?? 10_000
  }
}

class SharedRemoteConnection implements DatabaseConnection {
  constructor(
    private readonly context: {
      database: SharedSQLiteWasmDatabase
      sessionId: string
      epoch: string
      deadlineExpiresAtMilliseconds: number | undefined
    },
  ) {}

  async run(sql: string, parameters: readonly unknown[] = []): Promise<RunResult> {
    return (await this.statement({ operation: "run", sql, parameters })) as RunResult
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row | undefined> {
    return (await this.statement({ operation: "get", sql, parameters })) as Row | undefined
  }

  async all<Row extends object>(sql: string, parameters: readonly unknown[] = []): Promise<Row[]> {
    return (await this.statement({ operation: "all", sql, parameters })) as Row[]
  }

  async nowMilliseconds(): Promise<number> {
    return (await this.statement({ operation: "now", sql: "", parameters: [] })) as number
  }

  private statement(input: {
    operation: StatementOperation
    sql: string
    parameters: readonly unknown[]
  }): Promise<unknown> {
    requireDatabaseDeadlineRemaining()
    requireCapturedDeadline(this.context.deadlineExpiresAtMilliseconds)
    return this.context.database.sendStatement({
      sessionId: this.context.sessionId,
      epoch: this.context.epoch,
      operation: input.operation,
      sql: input.sql,
      parameters: input.parameters,
    })
  }
}

async function executeStatement(input: {
  connection: DatabaseConnection
  message: StatementMessage
}): Promise<unknown> {
  const { connection, message } = input
  if (message.operation === "run") return connection.run(message.sql, message.parameters)
  if (message.operation === "get") return connection.get(message.sql, message.parameters)
  if (message.operation === "all") return connection.all(message.sql, message.parameters)
  return connection.nowMilliseconds()
}

function requireCapturedDeadline(expiresAtMilliseconds: number | undefined): void {
  if (expiresAtMilliseconds === undefined) return
  if (performance.now() >= expiresAtMilliseconds) {
    throw new DatabaseDeadlineExceeded("database deadline exceeded")
  }
}

function envelope(): Envelope {
  return { protocol: PROTOCOL, version: VERSION }
}

function parseSharedMessage(value: unknown): SharedMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Partial<SharedMessage>
  if (candidate.protocol !== PROTOCOL || candidate.version !== VERSION) return undefined
  const kinds = ["ping", "pong", "holder-online", "open", "statement", "close", "result"]
  if (typeof candidate.kind !== "string" || !kinds.includes(candidate.kind)) return undefined
  return candidate as SharedMessage
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: "Error", message: String(error) }
}

function rebuildError(details: { name: string; message: string }): Error {
  if (details.name === "DatabaseDeadlineExceeded") {
    return new DatabaseDeadlineExceeded(details.message)
  }
  if (details.name === "SharedDatabaseFailover") return new SharedDatabaseFailover()
  const error = new Error(details.message)
  error.name = details.name
  return error
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

import type {
  Database,
  DatabaseConnection,
  DatabaseFamily,
  DatabaseTransactionOptions,
} from "../../src/database/types.js"

type ClaimTable = "broadcasts" | "effects" | "reminders"

export class PausingClaimDatabase implements Database {
  readonly family: DatabaseFamily
  readonly schemaIdentity: string
  private readonly claimLocked: Promise<void>
  private readonly resumeClaim: Promise<void>
  private resolveClaimLocked: () => void = () => {}
  private resolveResumeClaim: () => void = () => {}
  private pollingQueryCount = 0
  private paused = false
  private readonly table: ClaimTable
  private readonly pollingQueriesBeforePause: number

  constructor(options: {
    database: Database
    table: ClaimTable
    pollingQueriesBeforePause?: number
  }) {
    this.database = options.database
    this.table = options.table
    this.pollingQueriesBeforePause = options.pollingQueriesBeforePause ?? 1
    const { database } = options
    this.family = database.family
    this.schemaIdentity = database.schemaIdentity
    this.claimLocked = new Promise((resolve) => {
      this.resolveClaimLocked = resolve
    })
    this.resumeClaim = new Promise((resolve) => {
      this.resolveResumeClaim = resolve
    })
  }

  private readonly database: Database

  waitUntilClaimLocked(): Promise<void> {
    return this.claimLocked
  }

  resume(): void {
    this.resolveResumeClaim()
  }

  connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.database.connection((connection) => callback(this.pausingConnection(connection)))
  }

  transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
    options: DatabaseTransactionOptions = {},
  ): Promise<Result> {
    return this.database.transaction(
      (connection) => callback(this.pausingConnection(connection)),
      options,
    )
  }

  transactionActive(): boolean {
    return this.database.transactionActive?.() ?? false
  }

  close(): Promise<void> {
    return this.database.close()
  }

  private pausingConnection(connection: DatabaseConnection): DatabaseConnection {
    return {
      run: (sql, parameters) => connection.run(sql, parameters),
      get: async <Row extends object>(sql: string, parameters?: readonly unknown[]) => {
        const row = await connection.get<Row>(sql, parameters)
        if (!isPollingQuery(sql, this.table)) return row
        this.pollingQueryCount += 1
        if (
          this.paused ||
          (this.pollingQueryCount < this.pollingQueriesBeforePause &&
            !isCandidateLockQuery(sql, this.table))
        ) {
          return row
        }
        this.paused = true
        this.resolveClaimLocked()
        await this.resumeClaim
        return row
      },
      all: <Row extends object>(sql: string, parameters?: readonly unknown[]) =>
        connection.all<Row>(sql, parameters),
      nowMilliseconds: () => connection.nowMilliseconds(),
    }
  }
}

export async function captureAttempt<Result>(
  promise: Promise<Result>,
): Promise<{ value: Result } | { error: Error }> {
  try {
    return { value: await promise }
  } catch (error) {
    return { error: normalizeError(error) }
  }
}

function isPollingQuery(sql: string, table: ClaimTable): boolean {
  return new RegExp(
    `FROM\\s+\\S*${table}\\s+${table}[\\s\\S]*FOR UPDATE SKIP LOCKED\\s*$`,
    "i",
  ).test(sql)
}

function isCandidateLockQuery(sql: string, table: ClaimTable): boolean {
  return new RegExp(`WHERE\\s+${table}\\.id\\s*=\\s*\\?`, "i").test(sql)
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error("claim attempt rejected with a non-Error value", { cause: error })
}

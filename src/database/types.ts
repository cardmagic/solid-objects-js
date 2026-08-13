export type DatabaseFamily = "sqlite" | "postgresql" | "mysql"

export interface RunResult {
  changes: number
  lastInsertId?: string
}

export interface DatabaseConnection {
  run(sql: string, parameters?: readonly unknown[]): Promise<RunResult>
  get<Row extends object>(sql: string, parameters?: readonly unknown[]): Promise<Row | undefined>
  all<Row extends object>(sql: string, parameters?: readonly unknown[]): Promise<Row[]>
  nowMilliseconds(): Promise<number>
}

export interface Database {
  readonly family: DatabaseFamily
  readonly schemaIdentity: string
  connection<Result>(callback: (connection: DatabaseConnection) => Promise<Result>): Promise<Result>
  transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result>
  close(): Promise<void>
}

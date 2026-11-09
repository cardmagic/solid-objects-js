import type {
  Database,
  DatabaseConnection,
  DatabaseFamily,
  DatabaseTransactionOptions,
} from "../../src/database/types.js"

type Parameters = readonly unknown[] | undefined

export class CountingDatabase implements Database {
  readonly family: DatabaseFamily
  readonly schemaIdentity: string
  readonly statements: string[] = []

  constructor(private readonly database: Database) {
    this.family = database.family
    this.schemaIdentity = database.schemaIdentity
  }

  connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.database.connection((connection) => callback(this.counting(connection)))
  }

  transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
    options?: DatabaseTransactionOptions,
  ): Promise<Result> {
    return this.database.transaction(async (connection) => {
      this.statements.push("BEGIN")
      try {
        const result = await callback(this.counting(connection))
        this.statements.push("COMMIT")
        return result
      } catch (error) {
        this.statements.push("ROLLBACK")
        throw error
      }
    }, options)
  }

  transactionActive(): boolean {
    return this.database.transactionActive?.() ?? false
  }

  close(): Promise<void> {
    return this.database.close()
  }

  statementsSince(position: number): string[] {
    return this.statements.slice(position).map((statement) => statement.replace(/\s+/g, " "))
  }

  private counting(connection: DatabaseConnection): DatabaseConnection {
    return {
      run: (sql: string, parameters?: Parameters) => {
        this.statements.push(sql)
        return connection.run(sql, parameters)
      },
      get: <Row extends object>(sql: string, parameters?: Parameters) => {
        this.statements.push(sql)
        return connection.get<Row>(sql, parameters)
      },
      all: <Row extends object>(sql: string, parameters?: Parameters) => {
        this.statements.push(sql)
        return connection.all<Row>(sql, parameters)
      },
      nowMilliseconds: () => {
        this.statements.push("SELECT now")
        return connection.nowMilliseconds()
      },
    }
  }
}

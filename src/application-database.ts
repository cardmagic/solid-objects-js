import { applicationWritesForbidden } from "./context.js"
import type { Database, DatabaseConnection, DatabaseTransactionOptions } from "./database/types.js"
import { ApplicationWriteForbidden } from "./errors.js"

export function guardApplicationDatabase(database: Database): Database {
  return new GuardedApplicationDatabase(database)
}

class GuardedApplicationDatabase implements Database {
  readonly family
  readonly schemaIdentity

  constructor(private readonly database: Database) {
    this.family = database.family
    this.schemaIdentity = database.schemaIdentity
  }

  transactionActive(): boolean {
    return this.database.transactionActive?.() ?? false
  }

  connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.database.connection((connection) => callback(guardConnection(connection)))
  }

  transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
    options: DatabaseTransactionOptions = {},
  ): Promise<Result> {
    return this.database.transaction((connection) => callback(guardConnection(connection)), options)
  }

  close(): Promise<void> {
    return this.database.close()
  }
}

function guardConnection(connection: DatabaseConnection): DatabaseConnection {
  return {
    run(sql, parameters) {
      assertWriteAllowed()
      return connection.run(sql, parameters)
    },
    get<Row extends object>(sql: string, parameters?: readonly unknown[]) {
      assertReadAllowed(sql)
      return connection.get<Row>(sql, parameters)
    },
    all<Row extends object>(sql: string, parameters?: readonly unknown[]) {
      assertReadAllowed(sql)
      return connection.all<Row>(sql, parameters)
    },
    nowMilliseconds() {
      return connection.nowMilliseconds()
    },
  }
}

function assertWriteAllowed(): void {
  if (!applicationWritesForbidden()) return

  throw new ApplicationWriteForbidden(
    "application database writes are forbidden during actor execution",
  )
}

function assertReadAllowed(sql: string): void {
  if (!applicationWritesForbidden()) return
  if (/^\s*SELECT(?:\s|$)/i.test(sql)) return

  throw new ApplicationWriteForbidden(
    "application database reads must begin with SELECT during actor execution",
  )
}

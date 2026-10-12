import type { Database, DatabaseConnection } from "../../src/database/types.js"

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function controlledDatabaseClock(database: Database): {
  database: Database
  advanceMilliseconds(milliseconds: number): void
} {
  let now = Date.now()
  const clockedConnection = (connection: DatabaseConnection): DatabaseConnection => ({
    run: connection.run.bind(connection),
    get: connection.get.bind(connection),
    all: connection.all.bind(connection),
    nowMilliseconds: async () => now,
  })
  return {
    advanceMilliseconds: (milliseconds) => {
      now += milliseconds
    },
    database: {
      family: database.family,
      schemaIdentity: database.schemaIdentity,
      transactionActive: () => database.transactionActive?.() ?? false,
      ...(database.wakeUp ? { wakeUp: database.wakeUp.bind(database) } : {}),
      connection: (callback) =>
        database.connection((connection) => callback(clockedConnection(connection))),
      transaction: (callback, options) =>
        database.transaction((connection) => callback(clockedConnection(connection)), options),
      close: () => database.close(),
    },
  }
}

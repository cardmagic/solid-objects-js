import { createContextStore } from "../platform/context-store.js"

interface TransactionScope {
  database: object
  active: boolean
}

const transactionScopes = createContextStore<readonly TransactionScope[]>()

export function withDatabaseTransaction<Result>(
  database: object,
  operation: () => Promise<Result>,
): Promise<Result> {
  const scope: TransactionScope = { database, active: true }
  const scopes = [...(transactionScopes.getStore() ?? []), scope]
  return transactionScopes.run(scopes, async () => {
    try {
      return await operation()
    } finally {
      scope.active = false
    }
  })
}

export function databaseTransactionActive(database: object): boolean {
  return (
    transactionScopes.getStore()?.some((scope) => scope.database === database && scope.active) ??
    false
  )
}

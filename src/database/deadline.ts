import { AsyncLocalStorage } from "node:async_hooks"
import { DatabaseDeadlineExceeded } from "../errors.js"

interface DatabaseDeadline {
  expiresAt: number
}

const deadlines = new AsyncLocalStorage<DatabaseDeadline>()

export function withDatabaseDeadline<Result>(
  options: { timeoutMilliseconds: number },
  operation: () => Promise<Result>,
): Promise<Result> {
  return deadlines.run({ expiresAt: performance.now() + options.timeoutMilliseconds }, operation)
}

export function databaseDeadlineRemainingMilliseconds(): number | undefined {
  const deadline = deadlines.getStore()
  if (!deadline) return undefined
  return Math.max(Math.floor(deadline.expiresAt - performance.now()), 0)
}

export function requireDatabaseDeadlineRemaining(): number | undefined {
  const remaining = databaseDeadlineRemainingMilliseconds()
  if (remaining === undefined) return undefined
  if (remaining > 0) return remaining
  throw new DatabaseDeadlineExceeded("database deadline exceeded")
}

export function databaseDeadlineError(error: unknown): DatabaseDeadlineExceeded {
  return new DatabaseDeadlineExceeded("database deadline exceeded", { cause: error })
}

export async function acquireBeforeDatabaseDeadline<Resource>(
  acquire: Promise<Resource>,
  release: (resource: Resource) => void,
): Promise<Resource> {
  const remaining = requireDatabaseDeadlineRemaining()
  if (remaining === undefined) return acquire
  return new Promise<Resource>((resolve, reject) => {
    let expired = false
    const timeout = setTimeout(() => {
      expired = true
      reject(new DatabaseDeadlineExceeded("database deadline exceeded"))
    }, remaining)
    void acquire.then(
      (resource) => {
        clearTimeout(timeout)
        if (expired) {
          release(resource)
          return
        }
        resolve(resource)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        if (!expired) reject(error)
      },
    )
  })
}

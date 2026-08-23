export function requireWebLocks(): LockManager {
  const locks = globalThis.navigator?.locks
  if (!locks) {
    throw new Error("the Web Locks API is unavailable; leader election cannot run")
  }
  return locks
}

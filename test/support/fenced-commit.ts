import type { SolidObjectsRuntime } from "../../src/runtime.js"

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

export async function waitForActivationExpiration(
  runtime: SolidObjectsRuntime,
  actorType: string,
  actorId: string,
): Promise<void> {
  const expiration = await runtime.settings.database.connection((connection) =>
    connection.get<{ activation_expires_at_ms: number | bigint }>(
      `SELECT activation_expires_at_ms FROM ${runtime.repository.table("instances")}
       WHERE actor_type = ? AND actor_id = ?`,
      [actorType, actorId],
    ),
  )
  if (!expiration) throw new Error("active actor instance was not found")
  const expiresAt = Number(expiration.activation_expires_at_ms)
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const now = await runtime.settings.database.connection((connection) =>
      connection.nowMilliseconds(),
    )
    if (now > expiresAt) return
    await delay(Math.min(Math.max(expiresAt - now + 1, 1), 10))
  }
  throw new Error("activation lease did not expire")
}

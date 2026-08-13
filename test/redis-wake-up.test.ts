import { afterEach, describe, expect, it } from "vitest"
import { redisWakeUp, type RedisWakeUpAdapter } from "../src/wake-up/redis.js"

const redisUrl = process.env.SOLID_OBJECTS_REDIS_URL
const describeRedis = redisUrl?.startsWith("redis") ? describe : describe.skip
let adapters: RedisWakeUpAdapter[] = []

afterEach(() => {
  for (const adapter of adapters) adapter.close()
  adapters = []
})

describe("Redis wake-up configuration", () => {
  it("rejects invalid options before connecting", () => {
    expect(() => redisWakeUp({ url: "" })).toThrow("url must not be empty")
    expect(() => redisWakeUp({ url: "redis://localhost", channelPrefix: "not-valid" })).toThrow(
      "channelPrefix must contain only letters, digits, and underscores",
    )
    expect(() =>
      redisWakeUp({ url: "redis://localhost", connectionTimeoutMilliseconds: 0 }),
    ).toThrow("connectionTimeoutMilliseconds must be positive")
  })

  it("falls back to bounded polling when Redis is unavailable", async () => {
    const failures: string[] = []
    const adapter = redisWakeUp({
      url: "redis://127.0.0.1:1",
      connectionTimeoutMilliseconds: 25,
      onError: ({ operation }) => failures.push(operation),
    })
    adapters.push(adapter)
    const startedAt = performance.now()

    const watch = await adapter.watch("actors")
    await watch.wait({ timeoutMilliseconds: 1 })
    await adapter.notify("actors")

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(failures.length).toBeGreaterThan(0)
  })
})

describeRedis("Redis wake-up adapter", () => {
  it("wakes every matching waiter through another Redis client", async () => {
    if (!redisUrl) throw new Error("Redis URL is required")
    const listener = redisWakeUp({ url: redisUrl, channelPrefix: "solid_objects_test" })
    const notifier = redisWakeUp({ url: redisUrl, channelPrefix: "solid_objects_test" })
    adapters.push(listener, notifier)
    const actorWatches = await Promise.all([
      listener.watch("actors"),
      listener.watch("actors"),
      listener.watch("actors"),
    ])
    const effectWatch = await listener.watch("effects")
    const actorWaits = actorWatches
      .slice(0, 2)
      .map((watch) => watch.wait({ timeoutMilliseconds: 10_000 }))
    let effectResolved = false
    void effectWatch.wait({ timeoutMilliseconds: 10_000 }).then(() => {
      effectResolved = true
    })
    const startedAt = performance.now()

    await notifier.notify("actors")
    await Promise.all([...actorWaits, actorWatches[2]!.wait({ timeoutMilliseconds: 10_000 })])

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(effectResolved).toBe(false)
    listener.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(effectResolved).toBe(true)
  })
})

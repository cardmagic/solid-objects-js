import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { createRuntime, durableObjects } from "../../src/cloudflare/index.js"
import { EffectCallbacks, deliveries } from "./worker.js"

const authorizationContext = "allowed"
const runtime = () => createRuntime({ backend: durableObjects({ namespace: env.ACTORS }) })

describe("Cloudflare effect payloads", () => {
  it.each([null, false, 42, "reply", ["reply"], { reply: "done" }])(
    "delivers the complete success envelope for %j",
    async (result) => {
      const reference = runtime().ref(EffectCallbacks, `success-${JSON.stringify(result)}`)
      const argumentsValue = { generation: 2, nested: { retained: true }, result }
      await reference.with({ authorizationContext }).start(argumentsValue)
      await expect
        .poll(() =>
          reference.snapshot({ authorizationContext }).then((snapshot) => snapshot.received),
        )
        .toEqual([{ effectId: expect.any(String), arguments: argumentsValue, result }])
      const [payload] = (await reference.snapshot({ authorizationContext })).received
      expect(deliveries.get(payload!.effectId)).toBe(1)
    },
  )

  it("delivers empty arguments and normalizes an undefined result to null", async () => {
    const reference = runtime().ref(EffectCallbacks, "empty")
    await reference.with({ authorizationContext }).startEmpty()
    await expect
      .poll(() =>
        reference.snapshot({ authorizationContext }).then((snapshot) => snapshot.received),
      )
      .toEqual([{ effectId: expect.any(String), arguments: {}, result: null }])
  })

  it.each([
    { mode: "retry", attempts: 5, name: "Error", message: "exhausted" },
    { mode: "terminal", attempts: 1, name: "NonRetryableError", message: "terminal" },
    { mode: "non-error", attempts: 5, name: "Error", message: "delivery failed" },
  ])("delivers the complete failure envelope for $mode", async (options) => {
    const reference = runtime().ref(EffectCallbacks, options.mode)
    const argumentsValue = { mode: options.mode, generation: 3 }
    await reference.with({ authorizationContext }).start(argumentsValue)
    await expect
      .poll(() =>
        reference.snapshot({ authorizationContext }).then((snapshot) => snapshot.received),
      )
      .toEqual([
        {
          effectId: expect.any(String),
          arguments: argumentsValue,
          error: { name: options.name, message: options.message },
        },
      ])
    const [payload] = (await reference.snapshot({ authorizationContext })).received
    expect(deliveries.get(payload!.effectId)).toBe(options.attempts)
  })
})

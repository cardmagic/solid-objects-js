import { expect, it } from "vitest"
import { withRuntime, type ActorRuntime } from "../../src/core.js"
import { PortableCounter } from "./portable-actor.js"

export function portableRuntimeContract(runtime: () => ActorRuntime): void {
  const authorizationContext = "allowed"

  it("shares references, getters, snapshots, and async runtime context", async () => {
    await withRuntime(runtime(), async () => {
      await Promise.resolve()
      const reference = PortableCounter.ref("contract-reference")
      expect(await reference.with({ authorizationContext }).increment({ amount: 3 })).toBe(3)
      expect(await reference.with({ authorizationContext }).doubled).toBe(6)
      expect(await reference.snapshot({ authorizationContext })).toEqual({ count: 3, doubled: 6 })
    })
  })

  it("preserves accepted message identity and idempotency conflicts", async () => {
    const reference = runtime().ref(PortableCounter, "contract-message")
    const options = { authorizationContext, idempotencyKey: "same-operation" }
    const first = await reference.send.with(options).increment()
    const duplicate = await reference.send.with(options).increment()
    expect(duplicate.id).toBe(first.id)
    expect(typeof first.sequence).toBe("bigint")
    expect(await first.wait({ authorizationContext })).toBe(1)
    await expect(reference.send.with(options).increment({ amount: 2 })).rejects.toMatchObject({
      name: "IdempotencyConflict",
    })
  })

  it("serializes concurrent turns through awaits", async () => {
    const reference = runtime()
      .ref(PortableCounter, "contract-concurrent")
      .with({ authorizationContext })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reference.incrementAfterAwait()),
    )
    expect(results.sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5])
  })

  it("rolls back rejection without pausing the next turn", async () => {
    const reference = runtime()
      .ref(PortableCounter, "contract-rejection")
      .with({ authorizationContext })
    await expect(reference.rejectChange()).rejects.toMatchObject({
      name: "Rejected",
      code: "unavailable",
    })
    expect(await reference.increment()).toBe(1)
  })

  it("authorizes calls and fences references across destruction", async () => {
    const reference = runtime().ref(PortableCounter, "contract-destroy")
    await expect(reference.increment()).rejects.toMatchObject({ name: "Unauthorized" })
    const message = await reference.send.with({ authorizationContext }).increment()
    await message.wait({ authorizationContext })
    await reference.destroy({ authorizationContext })
    expect(await reference.with({ authorizationContext }).increment()).toBe(1)
    await expect(message.result({ authorizationContext })).rejects.toThrow()
  })
}

import assert from "node:assert/strict"

export interface CartSnapshot {
  readonly count: number
  readonly totalCents: number
  readonly lines: readonly {
    readonly sku: string
    readonly quantity: number
    readonly priceCents: number
  }[]
}

export interface CartEffect {
  name: string
  status: string
  arguments: string
}

export function verifyCartWork(input: {
  actorId: string
  expectedCount: number
  snapshot: CartSnapshot
  effects: readonly CartEffect[]
}): void {
  const { actorId, expectedCount, snapshot, effects } = input
  assert.ok(Number.isSafeInteger(expectedCount) && expectedCount > 0)
  assert.equal(snapshot.count, expectedCount, `committed count mismatch for ${actorId}`)
  const cycles = Math.floor(expectedCount / 20)
  const remainder = expectedCount % 20
  const expectedLines = Array.from({ length: 20 }, (_value, index) => ({
    sku: `sku-${index}`,
    quantity: 1 + cycles + (index < remainder ? 1 : 0),
    priceCents: 100 + index,
  }))
  assert.deepEqual(snapshot.lines, expectedLines, `cart lines mismatch for ${actorId}`)
  assert.equal(snapshot.totalCents, cartTotal(expectedCount), `cart total mismatch for ${actorId}`)
  assert.equal(effects.length, expectedCount, `cart effect count mismatch for ${actorId}`)
  const totals = effects.map((effect) => {
    assert.equal(effect.name, "cartChanged", `cart effect name mismatch for ${actorId}`)
    assert.equal(effect.status, "pending", `cart effect status mismatch for ${actorId}`)
    const argumentsValue: unknown = JSON.parse(effect.arguments)
    assert.ok(argumentsValue !== null && typeof argumentsValue === "object")
    assert.ok("totalCents" in argumentsValue && typeof argumentsValue.totalCents === "number")
    return argumentsValue.totalCents
  })
  assert.deepEqual(
    totals.sort((left, right) => left - right),
    Array.from({ length: expectedCount }, (_value, index) => cartTotal(index + 1)),
    `cart effect payload mismatch for ${actorId}`,
  )
}

function cartTotal(count: number): number {
  const remainder = count % 20
  return 2190 * (1 + Math.floor(count / 20)) + 100 * remainder + (remainder * (remainder - 1)) / 2
}

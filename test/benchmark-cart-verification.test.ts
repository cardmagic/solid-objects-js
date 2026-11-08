import { describe, expect, it } from "vitest"
import { verifyCartWork } from "../benchmarks/cart-verification.js"

describe("benchmark cart verification", () => {
  it.each([1, 22] as const)("checks complete state and outbox after %s operations", (count) => {
    expect(() => verifyCartWork(fixture(count))).not.toThrow()
  })

  it("does not depend on effect row order", () => {
    const input = fixture(22)
    input.effects.reverse()
    expect(() => verifyCartWork(input)).not.toThrow()
  })

  const corruptions: [string, (input: ReturnType<typeof fixture>) => void][] = [
    [
      "line quantities",
      (input) => {
        input.snapshot.lines[0]!.quantity -= 1
      },
    ],
    [
      "line prices",
      (input) => {
        input.snapshot.lines[0]!.priceCents += 1
      },
    ],
    [
      "missing lines",
      (input) => {
        input.snapshot.lines.pop()
      },
    ],
    [
      "cart totals",
      (input) => {
        input.snapshot.totalCents += 1
      },
    ],
    [
      "operation counts",
      (input) => {
        input.snapshot.count -= 1
      },
    ],
    [
      "missing outbox writes",
      (input) => {
        input.effects.pop()
      },
    ],
    [
      "duplicate effect payloads",
      (input) => {
        input.effects[21] = { ...input.effects[20]! }
      },
    ],
    [
      "wrong effect names",
      (input) => {
        input.effects[0]!.name = "wrong"
      },
    ],
    [
      "delivered effects",
      (input) => {
        input.effects[0]!.status = "completed"
      },
    ],
    [
      "incorrect effect totals",
      (input) => {
        input.effects[0]!.arguments = '{"totalCents":0}'
      },
    ],
  ]
  it.each(corruptions)("rejects %s even when the counter advances", (_name, corrupt) => {
    const input = fixture(22)
    corrupt(input)
    expect(() => verifyCartWork(input)).toThrow()
  })
})

function fixture(count: 1 | 22) {
  const totals =
    count === 1
      ? [2290]
      : [
          2290, 2391, 2493, 2596, 2700, 2805, 2911, 3018, 3126, 3235, 3345, 3456, 3568, 3681, 3795,
          3910, 4026, 4143, 4261, 4380, 4480, 4581,
        ]
  return {
    actorId: "test-cart",
    expectedCount: count,
    snapshot: {
      count,
      totalCents: count === 1 ? 2290 : 4581,
      lines: Array.from({ length: 20 }, (_value, index) => ({
        sku: `sku-${index}`,
        priceCents: 100 + index,
        quantity: count === 1 ? (index === 0 ? 2 : 1) : index < 2 ? 3 : 2,
      })),
    },
    effects: totals.map((totalCents) => ({
      name: "cartChanged",
      status: "pending",
      arguments: JSON.stringify({ totalCents }),
    })),
  }
}

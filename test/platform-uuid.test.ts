import { describe, expect, it } from "vitest"
import { randomUUID } from "../src/platform/uuid.js"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("platform uuid", () => {
  it("returns a version 4 UUID", () => {
    expect(randomUUID()).toMatch(UUID_PATTERN)
  })

  it("returns a distinct value on every call", () => {
    const values = new Set(Array.from({ length: 100 }, () => randomUUID()))
    expect(values.size).toBe(100)
  })
})

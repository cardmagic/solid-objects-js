import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { PayloadTooLarge } from "../src/errors.js"
import { createRuntime } from "../src/runtime.js"
import { normalizeJson, readonlyCopy, stableJson } from "../src/serialization.js"
import type { JsonObject } from "../src/types.js"

const fixtures: { name: string; value: JsonObject }[] = JSON.parse(
  readFileSync(new URL("../compatibility/json-values.json", import.meta.url), "utf8"),
)

for (const { name, value } of fixtures) {
  it(`preserves ${name} as JSON data`, () => {
    const normalized = normalizeJson(value)
    expect(JSON.stringify(normalized)).toBe(JSON.stringify(value))
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype)
    expect(readonlyCopy(value)).toStrictEqual(value)
    expect(JSON.parse(stableJson(value))).toStrictEqual(value)
  })
}

it("includes reserved keys in the encoded byte limit", () => {
  const value = JSON.parse('{"__proto__":"long payload"}')
  expect(() => normalizeJson(value, { maxBytes: 2 })).toThrow(PayloadTooLarge)
})

class JsonActor extends Actor {
  static override readonly actorType = "json-compatibility"
  payload: JsonObject = {}

  store({ payload }: { payload: JsonObject }): JsonObject {
    this.payload = payload
    return payload
  }
}

it("preserves reserved keys through actor arguments, state, and results", async () => {
  const runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    wakeUp: "in_process",
    authorizeMessage: () => true,
    authorizeQuery: () => true,
  })
  try {
    await runtime.install()
    runtime.register(JsonActor)
    const reference = runtime.ref(JsonActor, "one")
    for (const { name, value } of fixtures) {
      const message = await reference.send.with({ idempotencyKey: name }).store({ payload: value })
      await runtime.worker().runUntilIdle()
      expect(await message.result()).toStrictEqual(value)
      expect((await reference.snapshot()).payload).toStrictEqual(value)
    }
  } finally {
    await runtime.close()
  }
})

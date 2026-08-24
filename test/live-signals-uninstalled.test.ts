import { describe, expect, it } from "vitest"
import "../src/platform/node.js"
import { Actor } from "../src/actor.js"
import { createRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"

class PlainCounter extends Actor {
  static override readonly actorType = "PlainCounter"

  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }
}

describe("live signals without the signals entry", () => {
  it("explains that solid-objects/signals must be imported", () => {
    const runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
    })
    const counter = runtime.ref(PlainCounter, "plain")
    expect(() => counter.live).toThrow("solid-objects/signals")
  })
})

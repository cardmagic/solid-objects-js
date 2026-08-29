import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import { buildSettings, type InstrumentationEvent } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { initialStateFor, validateDefinition } from "../src/definition.js"
import { PayloadTooLarge } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { normalizeJson } from "../src/serialization.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"

const stateReads = { count: 0 }

class TracedStateActor extends Actor {
  static override readonly actorType = "TracedStateActor"

  count = 0

  constructor(actorId?: string) {
    super(actorId)
    let payload: string = "traced"
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      get: () => {
        stateReads.count += 1
        return payload
      },
      set: (value: string) => {
        payload = value
      },
    })
  }

  increment(): number {
    this.count += 1
    return this.count
  }
}

class DefaultsActor extends Actor {
  static override readonly actorType = "DefaultsActor"
  static constructions = 0

  count = 0
  items: string[] = []

  constructor(actorId?: string) {
    super(actorId)
    DefaultsActor.constructions += 1
  }
}

class LargeStateActor extends Actor {
  static override readonly actorType = "LargeStateActor"

  payload = ""

  grow({ size }: { size: number }): number {
    this.payload = "s".repeat(size)
    return this.payload.length
  }

  growThenFailTheCommit({ size }: { size: number }): number {
    this.payload = "s".repeat(size)
    this.commitAction("explode")
    return this.payload.length
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("normalizeJson byte limit", () => {
  it("does not encode the value when no byte limit is given", () => {
    const stringify = vi.spyOn(JSON, "stringify")
    try {
      normalizeJson({ nested: { count: 1, items: ["one", "two"] } })
      expect(stringify).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })

  it("raises PayloadTooLarge above the configured limit", () => {
    expect(() => normalizeJson({ payload: "x".repeat(64) }, { maxBytes: 16 })).toThrow(
      PayloadTooLarge,
    )
  })

  it("returns the normalized value below the configured limit", () => {
    expect(normalizeJson({ count: 1 }, { maxBytes: 1_024 })).toEqual({ count: 1 })
  })
})

describe("initialStateFor memoization", () => {
  it("computes the default state once for one validated definition", () => {
    const definition = validateDefinition(DefaultsActor)
    DefaultsActor.constructions = 0

    initialStateFor(definition)
    initialStateFor(definition)
    initialStateFor(definition)

    expect(DefaultsActor.constructions).toBe(1)
  })

  it("returns a detached copy that a caller cannot use to mutate the cache", () => {
    const definition = validateDefinition(DefaultsActor)
    const first = initialStateFor(definition) as { count: number; items: string[] }
    first.count = 99
    first.items.push("mutated")

    expect(initialStateFor(definition)).toEqual({ count: 0, items: [] })
  })

  it("computes the default state again for a separate validated definition", () => {
    DefaultsActor.constructions = 0
    const first = validateDefinition(DefaultsActor)
    const second = validateDefinition(DefaultsActor)
    const constructionsAfterValidation = DefaultsActor.constructions

    initialStateFor(first)
    initialStateFor(second)

    expect(DefaultsActor.constructions).toBe(constructionsAfterValidation + 2)
  })
})

describe("per-turn state traversals", () => {
  it("traverses the whole state twice for the commit and once for each observables guard", async () => {
    runtime = configuredRuntime()
    runtime.register(TracedStateActor)
    await runtime.install()
    const reference = runtime.ref(TracedStateActor, "traced")
    await reference.send.increment()
    await runtime.worker().runUntilIdle()

    stateReads.count = 0
    await reference.send.increment()
    await runtime.worker().runUntilIdle()

    expect(stateReads.count).toBe(4)
  })

  it("reuses the committed image for the query mutation check", async () => {
    runtime = configuredRuntime()
    runtime.register(TracedStateActor)
    await runtime.install()
    const reference = runtime.ref(TracedStateActor, "traced-query")
    await reference.send.increment()
    await runtime.worker().runUntilIdle()

    stateReads.count = 0
    expect(await reference.count).toBe(1)

    expect(stateReads.count).toBe(4)
  })
})

describe("large committed state warning", () => {
  it("defaults warnStateBytes to 131072", () => {
    expect(buildSettings({ database: sqlite({ path: ":memory:" }) }).warnStateBytes).toBe(131_072)
  })

  it("emits one instrumentation event with the actor type, actor id, and byte count", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      warnStateBytes: 256,
      instrumentation: (event) => events.push(event),
    })
    runtime.register(LargeStateActor)
    await runtime.install()

    await runtime.ref(LargeStateActor, "wide").send.grow({ size: 1_024 })
    await runtime.worker().runUntilIdle()

    const warnings = events.filter((event) => event.name === "solid_objects.state.large")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.attributes).toMatchObject({
      actorType: "LargeStateActor",
      actorId: "wide",
      thresholdBytes: 256,
    })
    expect(Number(warnings[0]?.attributes.byteCount)).toBeGreaterThan(1_024)
  })

  it("keeps application state out of the warning event", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      warnStateBytes: 256,
      instrumentation: (event) => events.push(event),
    })
    runtime.register(LargeStateActor)
    await runtime.install()

    await runtime.ref(LargeStateActor, "quiet").send.grow({ size: 1_024 })
    await runtime.worker().runUntilIdle()

    const warning = events.find((event) => event.name === "solid_objects.state.large")
    expect(JSON.stringify(warning?.attributes)).not.toContain("ss")
  })

  it("stays silent when the commit fails and the state is rolled back", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      warnStateBytes: 256,
      instrumentation: (event) => events.push(event),
    })
    runtime.register(LargeStateActor)
    runtime.registerCommitAction("explode", () => {
      throw new Error("the commit action failed")
    })
    await runtime.install()

    await runtime.ref(LargeStateActor, "rolled-back").send.growThenFailTheCommit({ size: 1_024 })
    await runtime.worker().runUntilIdle()

    expect(events.map((event) => event.name)).toContain("solid_objects.message.failed")
    expect(events.filter((event) => event.name === "solid_objects.state.large")).toHaveLength(0)
  })

  it("stays silent below the threshold", async () => {
    const events: InstrumentationEvent[] = []
    runtime = configuredRuntime({
      warnStateBytes: 131_072,
      instrumentation: (event) => events.push(event),
    })
    runtime.register(LargeStateActor)
    await runtime.install()

    await runtime.ref(LargeStateActor, "small").send.grow({ size: 16 })
    await runtime.worker().runUntilIdle()

    expect(events.filter((event) => event.name === "solid_objects.state.large")).toHaveLength(0)
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    maxAttempts: 1,
    ...overrides,
  })
}

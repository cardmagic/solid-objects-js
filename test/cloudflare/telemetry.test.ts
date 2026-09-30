import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { createRuntime, durableObjects } from "../../src/cloudflare/index.js"
import { Counter, telemetryEvents } from "./worker.js"

const authorizationContext = "allowed"

describe("portable Durable Objects telemetry", () => {
  it("uses the common envelope and authorizes bounded diagnostics", async () => {
    const runtime = createRuntime({ backend: durableObjects({ namespace: env.ACTORS }) })
    const reference = runtime.ref(Counter, "telemetry")
    await expect(reference.diagnostics()).rejects.toMatchObject({ name: "Unauthorized" })
    expect(await reference.with({ authorizationContext }).increment()).toBe(1)
    await reference.snapshot({ authorizationContext })
    const summary = await reference.diagnostics({ authorizationContext, limit: 1 })
    expect(summary).toMatchObject({
      adapter: "durable-objects",
      actorId: "telemetry",
      limit: 1,
      mailbox: { sampled: 0, truncated: false },
    })
    const event = telemetryEvents.find(
      (event) => event.actorId === "telemetry" && event.name === "solid_objects.message.completed",
    )
    expect(event).toMatchObject({
      schemaVersion: 1,
      adapter: "durable-objects",
      actorType: "Counter",
      incarnation: expect.any(String),
      messageId: expect.any(String),
      attempt: 1,
    })
    expect(event?.metrics[0]?.labels).toEqual({
      event: "solid_objects.message.completed",
      adapter: "durable-objects",
      actorType: "Counter",
    })
    await expect(reference.diagnostics({ authorizationContext, limit: 101 })).rejects.toThrow()
  })
})

import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { portableAttributes, telemetryEvent } from "../src/telemetry.js"
import { telemetryContract } from "./support/portable-telemetry.js"

const fixtures: { rubyReason: string; waitingOn: string }[] = JSON.parse(
  readFileSync(new URL("../compatibility/sync-timeout.json", import.meta.url), "utf8"),
)

it("matches the shared portable attribute allowlist", () => {
  expect([...portableAttributes].sort()).toEqual([...telemetryContract.attributes].sort())
})

it.each(fixtures)("preserves portable $waitingOn timeout diagnostics", ({ waitingOn }) => {
  const event = telemetryEvent({
    name: "sync.timeout",
    adapter: "sqlite",
    attributes: {
      waitingOn,
      activationOwnerId: "worker-1",
      activationGeneration: "7",
      arguments: { secret: "private" },
    },
  })

  expect(event.attributes).toEqual({
    waitingOn,
    activationOwnerId: "worker-1",
    activationGeneration: "7",
  })
})

it("preserves unknown activation fields during database contention", () => {
  const attributes = {
    waitingOn: "databaseContention",
    activationOwnerId: null,
    activationGeneration: null,
  }

  expect(
    telemetryEvent({ name: "sync.timeout", adapter: "sqlite", attributes }).attributes,
  ).toEqual(attributes)
})

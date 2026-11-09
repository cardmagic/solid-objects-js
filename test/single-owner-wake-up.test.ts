import { afterEach, describe, expect, it, vi } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { InProcessWakeUpAdapter } from "../src/wake-up.js"

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await runtime?.close()
  runtime = undefined
})

function singleOwnerRuntime(wakeUp: "automatic" | "in_process"): SolidObjectsRuntime {
  return createRuntime({
    database: sqlite({ path: ":memory:" }),
    singleOwner: true,
    wakeUp,
    authorizeAdministration: () => true,
  })
}

describe("singleOwner wake-ups", () => {
  it.each(["automatic", "in_process"] as const)(
    "selects in-process signalling for %s even when a Redis URL is set",
    async (wakeUp) => {
      vi.stubEnv("SOLID_OBJECTS_REDIS_URL", "redis://127.0.0.1:1")
      runtime = singleOwnerRuntime(wakeUp)

      const capability = await runtime.wakeUpCapability()

      expect(capability).toEqual({
        adapter: "in_process",
        crossesProcesses: false,
        reason:
          "singleOwner is set, so one process owns the database and in-process signalling reaches every role",
      })
      expect(await runtime.wakeUpAdapter()).toBeInstanceOf(InProcessWakeUpAdapter)
    },
  )

  it("passes the doctor wake-up check, because no other process can commit", async () => {
    runtime = singleOwnerRuntime("automatic")
    await runtime.install()

    const report = await runtime.doctor.run({ roundTrip: "skip" })

    expect(report.checks.find((check) => check.name === "wakeUp")).toMatchObject({
      status: "pass",
    })
  })
})

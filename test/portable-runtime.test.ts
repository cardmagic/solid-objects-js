import { afterEach, beforeEach, describe } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { PortableCounter } from "./support/portable-actor.js"
import { portableRuntimeContract } from "./support/portable-runtime-contract.js"

describe("SQL portable runtime contract", () => {
  let runtime: SolidObjectsRuntime
  let controller: AbortController
  let running: Promise<void>
  beforeEach(async () => {
    runtime = createRuntime({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: (input) => input.authorizationContext === "allowed",
      authorizeQuery: (input) => input.authorizationContext === "allowed",
      authorizeDestroy: (input) => input.authorizationContext === "allowed",
      syncPollingIntervalMilliseconds: 1,
      pollingIntervalMilliseconds: 1,
    })
    runtime.register(PortableCounter)
    await runtime.install()
    controller = new AbortController()
    running = runtime.run(controller.signal)
  })
  afterEach(async () => {
    controller?.abort()
    await running
    await runtime?.close()
  })
  portableRuntimeContract(() => runtime)
})

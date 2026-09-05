import { afterEach, expect, it, vi } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { PortableCounter } from "./support/portable-actor.js"

let runtime: SolidObjectsRuntime | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await runtime?.close()
})

it("does not combine an old result with a newer completed status", async () => {
  runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
  })
  runtime.register(PortableCounter)
  await runtime.install()
  const message = await runtime.ref(PortableCounter, "snapshot-race").send.increment()
  const findMessage = runtime.repository.findMessage.bind(runtime.repository)
  let reads = 0
  vi.spyOn(runtime.repository, "findMessage").mockImplementation(async (id) => {
    const stale = await findMessage(id)
    reads += 1
    if (reads === 2) await runtime!.testing.drain({ roles: ["actors"] })
    return stale
  })
  expect(await message.wait()).toBe(1)
})

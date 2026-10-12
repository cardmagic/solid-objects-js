import { expect, it } from "vitest"
import { processMessages } from "../examples/failure-recovery/process-messages.js"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { createRuntime } from "../src/runtime.js"

it("drains recovered messages after a demo worker loses its lease", async () => {
  class RecoveryCounter extends Actor {
    static override readonly actorType = "RecoveryWorkerCounter"
    count = 0

    increment(options: { block?: "first-attempt" }): number {
      if (options.block && this.currentMessage?.attempt === 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
      }
      this.count += 1
      return this.count
    }
  }

  const lostActivations: string[] = []
  const runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    leaseDurationMilliseconds: 200,
    leaseRenewalIntervalMilliseconds: 50,
    maxMessagesPerActivationPass: 1,
    maxAttempts: 1,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    instrumentation: ({ name }) => {
      if (name === "solid_objects.activation.lost") lostActivations.push(name)
    },
  })
  runtime.register(RecoveryCounter)
  const worker = runtime.worker()

  try {
    await runtime.install()
    const reference = runtime.ref(RecoveryCounter, "counter")
    const first = await reference.send.increment({ block: "first-attempt" })
    const second = await reference.send.increment({})

    await processMessages(worker)

    expect(await first.status()).toBe("completed")
    expect(await second.status()).toBe("completed")
    expect(await first.result()).toBe(1)
    expect(await second.result()).toBe(2)
    expect((await reference.snapshot()).count).toBe(2)
    expect(lostActivations).toHaveLength(1)
    expect(Number((await runtime.repository.findMessage(first.id))?.attempt_count)).toBe(2)
  } finally {
    await worker.stop()
    await runtime.close()
  }
})

import { createRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { DeliveryCounter } from "./actor.ts"
import { recordDelivery } from "./sink.ts"

const databasePath = requiredArgument(2)
const sinkPath = requiredArgument(3)
const mode = requiredArgument(4)
const deduplicate = requiredArgument(5) === "on"

const runtime = createRuntime({
  database: sqlite({ path: databasePath, timeoutMilliseconds: 2_000, lockRetryAttempts: 20 }),
  pollingIntervalMilliseconds: 10,
  leaseDurationMilliseconds: 250,
  leaseRenewalIntervalMilliseconds: 50,
  processHeartbeatIntervalMilliseconds: 75,
  processAliveThresholdMilliseconds: 300,
  workerCount: 0,
  effectWorkerCount: 1,
  reminderSchedulerCount: 0,
  retentionIntervalMilliseconds: 0,
  deadProcessCleanupIntervalMilliseconds: 0,
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  authorizeAdministration: () => true,
})

runtime.register(DeliveryCounter)
runtime.registerEffect("record", async (_argumentsValue, context) => {
  const { applied } = await recordDelivery({
    path: sinkPath,
    effectId: context.id,
    attempt: context.attempt,
    deduplicate,
  })
  process.send?.({ event: "sink.recorded", effectId: context.id, applied })
  if (mode === "crash") {
    process.exit(1)
  }
  return null
})
await runtime.install()
const effectWorker = runtime.effectWorker()

try {
  let processed = 0
  for (let attempt = 0; attempt < 200 && processed === 0; attempt += 1) {
    processed = await effectWorker.runOnce()
    if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (processed === 0) throw new Error("no effect became claimable")
  process.send?.({ event: "effects.finished", processed })
} finally {
  await effectWorker.stop()
  await runtime.close()
}

function requiredArgument(index: number): string {
  const value = process.argv[index]
  if (!value) throw new TypeError(`argument ${index - 1} is required`)
  return value
}

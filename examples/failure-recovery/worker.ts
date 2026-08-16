import { createRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { RecoveryCounter } from "./actor.ts"

const databasePath = requiredArgument(2)
const runtime = createRuntime({
  database: sqlite({ path: databasePath, timeoutMilliseconds: 2_000, lockRetryAttempts: 20 }),
  pollingIntervalMilliseconds: 10,
  leaseDurationMilliseconds: 250,
  leaseRenewalIntervalMilliseconds: 50,
  processHeartbeatIntervalMilliseconds: 75,
  processAliveThresholdMilliseconds: 300,
  workerCount: 1,
  effectWorkerCount: 0,
  reminderSchedulerCount: 0,
  retentionIntervalMilliseconds: 0,
  deadProcessCleanupIntervalMilliseconds: 0,
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  authorizeAdministration: () => true,
  instrumentation: ({ name, attributes }) => {
    process.send?.({ event: name, attributes })
  },
})

runtime.register(RecoveryCounter)
await runtime.install()
const worker = runtime.worker()

try {
  let processed = 0
  for (let attempt = 0; attempt < 200 && processed === 0; attempt += 1) {
    processed = await worker.runOnce({ activationRetention: "release" })
    if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  process.send?.({ event: "worker.finished", processed })
} finally {
  await worker.stop()
  await runtime.close()
}

function requiredArgument(index: number): string {
  const value = process.argv[index]
  if (!value) throw new TypeError(`argument ${index - 1} is required`)
  return value
}

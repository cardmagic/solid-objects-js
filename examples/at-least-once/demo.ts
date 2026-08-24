import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { DeliveryCounter } from "./actor.ts"
import { readSink } from "./sink.ts"

const directory = await mkdtemp(join(tmpdir(), "solid-objects-at-least-once-"))
const databasePath = join(directory, "state.sqlite3")
const runtime = createRuntime({
  database: sqlite({ path: databasePath, timeoutMilliseconds: 2_000, lockRetryAttempts: 20 }),
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
})

try {
  runtime.register(DeliveryCounter)
  await runtime.install()
  const duplicate = await proveDuplicateAtSink()
  const remedy = await proveDeduplicationAbsorbsIt()
  process.stdout.write(`${JSON.stringify({ duplicate, remedy }, null, 2)}\n`)
} finally {
  await runtime.close()
  await rm(directory, { recursive: true })
}

async function proveDuplicateAtSink(): Promise<{
  stateCommits: number
  sinkDeliveries: number
  sameEffectId: boolean
  attempts: number[]
}> {
  const sinkPath = join(directory, "sink-dedup-off.json")
  await stageOneDelivery("dedup-off")
  await crashThenRecover({ sinkPath, deduplicate: "off" })

  const sink = await readSink(sinkPath)
  const snapshot = await runtime.ref(DeliveryCounter, "dedup-off").snapshot()
  assert.equal(snapshot.count, 1, "the state commit happened exactly once")
  assert.equal(sink.deliveries.length, 2, "the sink observed the duplicate")
  assert.equal(
    sink.deliveries[0]?.effectId,
    sink.deliveries[1]?.effectId,
    "both deliveries carried the same stable effect id",
  )
  return {
    stateCommits: snapshot.count,
    sinkDeliveries: sink.deliveries.length,
    sameEffectId: sink.deliveries[0]?.effectId === sink.deliveries[1]?.effectId,
    attempts: sink.deliveries.map((delivery) => delivery.attempt),
  }
}

async function proveDeduplicationAbsorbsIt(): Promise<{
  stateCommits: number
  sinkDeliveries: number
}> {
  const sinkPath = join(directory, "sink-dedup-on.json")
  await stageOneDelivery("dedup-on")
  await crashThenRecover({ sinkPath, deduplicate: "on" })

  const sink = await readSink(sinkPath)
  const snapshot = await runtime.ref(DeliveryCounter, "dedup-on").snapshot()
  assert.equal(snapshot.count, 1, "the state commit happened exactly once")
  assert.equal(sink.deliveries.length, 1, "the stable effect id absorbed the duplicate")
  return { stateCommits: snapshot.count, sinkDeliveries: sink.deliveries.length }
}

async function stageOneDelivery(actorId: string): Promise<void> {
  const message = await runtime.ref(DeliveryCounter, actorId).send.deliver()
  const worker = runtime.worker()
  try {
    let processed = 0
    for (let attempt = 0; attempt < 200 && processed === 0; attempt += 1) {
      processed = await worker.runOnce({ activationRetention: "release" })
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(processed, 1, "the actor turn committed and staged the effect")
  } finally {
    await worker.stop()
  }
  assert.equal(await message.status(), "completed")
}

async function crashThenRecover(options: {
  sinkPath: string
  deduplicate: "on" | "off"
}): Promise<void> {
  const crashing = spawnEffectWorker({ ...options, mode: "crash" })
  const crashExit = await crashing.finished
  assert.equal(crashExit, 1, "the first delivery crashed before acknowledgement")

  await new Promise((resolve) => setTimeout(resolve, 400))

  const recovering = spawnEffectWorker({ ...options, mode: "complete" })
  const recoveryExit = await recovering.finished
  assert.equal(recoveryExit, 0, "the second delivery completed and acknowledged")
}

function spawnEffectWorker(options: {
  sinkPath: string
  deduplicate: "on" | "off"
  mode: "crash" | "complete"
}): { child: ChildProcess; finished: Promise<number | null> } {
  const child = fork(
    fileURLToPath(new URL("./effect-worker.ts", import.meta.url)),
    [databasePath, options.sinkPath, options.mode, options.deduplicate],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  )
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code))
    child.once("error", reject)
  })
  return { child, finished }
}

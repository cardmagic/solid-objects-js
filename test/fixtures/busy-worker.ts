import { writeSync } from "node:fs"
import { Actor, createRuntime } from "../../src/index.js"
import { sqlite } from "../../src/database/sqlite.js"

const scenario = process.argv[2] ?? "lease-timer"
const role = process.argv[3] ?? "actors"
const execution = process.argv[4] ?? "run"
const leaseScenario = scenario.startsWith("lease-")
const messageCount = Number(process.env.BUSY_MESSAGE_COUNT ?? 100)
const turnMilliseconds = Number(process.env.BUSY_TURN_MILLISECONDS ?? 2)
const controller = new AbortController()
let completed = 0
let ticks = 0
let completedAtFirstTick = -1
let inputReceived = false
let lastTick = 0
let maximumTimerGapMilliseconds = 0
const attempts: number[] = []
const ticksAtLoss: number[] = []

function block(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function finishWork(): void {
  block(turnMilliseconds)
  completed += 1
  if (completed === messageCount) controller.abort()
}

class BusyActor extends Actor {
  static override readonly actorType = "BusyActor"
  count = 0

  increment(): void {
    if (leaseScenario) block(400)
    this.count += 1
  }

  stage(): void {
    for (let index = 0; index < messageCount; index += 1) {
      if (role === "effects") this.emit("busy-effect")
      if (role === "reminders") this.schedule({ at: new Date(0), key: String(index) }).increment()
    }
  }

  override observables(): Record<string, unknown> {
    return { count: this.count }
  }
}

const runtime = createRuntime({
  database: sqlite({ path: ":memory:" }),
  maxAttempts: 1,
  leaseDurationMilliseconds: leaseScenario ? 100 : 30_000,
  leaseRenewalIntervalMilliseconds: leaseScenario ? 30 : 5_000,
  workerCount: role === "actors" ? 1 : 0,
  effectWorkerCount: role === "effects" ? 1 : 0,
  reminderSchedulerCount: role === "reminders" ? 1 : 0,
  broadcastWorkerCount: role === "broadcasts" ? 1 : 0,
  retentionIntervalMilliseconds: 0,
  deadProcessCleanupIntervalMilliseconds: 0,
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  wakeUp: "in_process",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  ...(role === "broadcasts" ? { broadcast: async () => finishWork() } : {}),
  instrumentation: (event) => {
    if (event.name === "solid_objects.activation.lost") {
      attempts.push(event.attempt)
      ticksAtLoss.push(ticks)
      writeSync(1, `${JSON.stringify({ event: "lost", attempts, ticks })}\n`)
      if (scenario === "lease-callback" && attempts.length === 3) controller.abort()
    }
    if (!lastTick || leaseScenario) return
    if (role === "actors" && event.name === "solid_objects.message.completed") finishWork()
    if (role === "reminders" && event.name === "solid_objects.reminder.enqueued") finishWork()
  },
})
runtime.register(BusyActor)
runtime.registerEffect("busy-effect", async () => finishWork())
await runtime.install()
const reference = runtime.ref(BusyActor, "one")
if (role === "actors" || role === "broadcasts") {
  for (let index = 0; index < (leaseScenario ? 1 : messageCount); index += 1) {
    await reference.send.increment()
  }
} else {
  await reference.send.stage()
}
if (role !== "actors") {
  const setupWorker = runtime.worker()
  await setupWorker.runUntilIdle()
  await setupWorker.stop()
}

const startedAt = performance.now()
lastTick = startedAt
const timer = setInterval(() => {
  if (ticks === 0) completedAtFirstTick = completed
  const now = performance.now()
  maximumTimerGapMilliseconds = Math.max(maximumTimerGapMilliseconds, now - lastTick)
  lastTick = now
  ticks += 1
}, 20)
const abortTimer =
  scenario === "lease-timer" ? setTimeout(() => controller.abort(), 900) : undefined
process.stdin.once("data", () => {
  inputReceived = true
})
writeSync(1, `${JSON.stringify({ event: "ready" })}\n`)
try {
  if (execution === "run") await runtime.run(controller.signal)
  else if (execution === "drain")
    await runtime.testing.drain({
      roles: [role as "actors" | "effects" | "reminders" | "broadcasts"],
    })
  else if (execution === "due-reminders") await runtime.testing.runDueReminders({ now: new Date() })
  else {
    const worker =
      role === "actors"
        ? runtime.worker()
        : role === "effects"
          ? runtime.effectWorker()
          : role === "reminders"
            ? runtime.reminderScheduler()
            : runtime.broadcastWorker()
    try {
      await worker.runUntilIdle()
    } finally {
      await worker.stop()
    }
  }
  const elapsedMilliseconds = performance.now() - startedAt
  maximumTimerGapMilliseconds = Math.max(maximumTimerGapMilliseconds, performance.now() - lastTick)
  writeSync(
    1,
    `${JSON.stringify({ event: "finished", elapsedMilliseconds, maximumTimerGapMilliseconds, ticks, completedAtFirstTick, inputReceived, attempts, ticksAtLoss, completed, count: (await reference.snapshot()).count })}\n`,
  )
} finally {
  clearInterval(timer)
  clearTimeout(abortTimer)
  process.stdin.destroy()
  await runtime.close()
}

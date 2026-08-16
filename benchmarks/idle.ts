import { readFile } from "node:fs/promises"
import { cpus, platform, release } from "node:os"
import { createRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import type { WakeUpAdapter, WakeUpRole, WakeUpWatch } from "../src/wake-up.ts"

const roles = ["actors", "effects", "reminders", "broadcasts"] as const
const intervals = option("intervals", "20,100,500")
  .split(",")
  .map((value) => positiveNumber(value, "intervals"))
const warmupMilliseconds = positiveNumber(option("warmup", "3000"), "warmup")
const durationMilliseconds = positiveNumber(option("duration", "10000"), "duration")

async function main(): Promise<void> {
  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
  const results = []
  const databaseVersion = await readDatabaseVersion()

  for (const pollingIntervalMilliseconds of intervals) {
    results.push(await measure(pollingIntervalMilliseconds))
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        packageVersion: packageMetadata.version,
        runtime: {
          node: process.version,
          platform: `${platform()} ${release()}`,
          cpu: cpus()[0]?.model ?? "unknown",
          logicalCpus: cpus().length,
        },
        database: { adapter: "sqlite", version: databaseVersion, path: ":memory:" },
        methodology: {
          roles,
          warmupMilliseconds,
          durationMilliseconds,
          cpuPercent: "process user plus system CPU time divided by wall time",
        },
        results,
      },
      null,
      2,
    )}\n`,
  )
}

async function readDatabaseVersion(): Promise<string> {
  const database = sqlite({ path: ":memory:" })
  try {
    return await database.connection(async (connection) => {
      const row = await connection.get<{ version: string }>("SELECT sqlite_version() AS version")
      return row?.version ?? "unknown"
    })
  } finally {
    await database.close()
  }
}

async function measure(pollingIntervalMilliseconds: number) {
  const wakeUp = new CountingWakeUpAdapter()
  const runtime = createRuntime({
    database: sqlite({ path: ":memory:" }),
    pollingIntervalMilliseconds,
    workerCount: 1,
    effectWorkerCount: 1,
    reminderSchedulerCount: 1,
    broadcastWorkerCount: 1,
    retentionIntervalMilliseconds: 0,
    deadProcessCleanupIntervalMilliseconds: 0,
    authorizeSubscription: () => true,
    broadcast: async () => {},
    wakeUp,
  })
  await runtime.install()
  const controller = new AbortController()
  const running = [
    runtime.worker().run(controller.signal),
    runtime.effectWorker().run(controller.signal),
    runtime.reminderScheduler().run(controller.signal),
    runtime.broadcastWorker().run(controller.signal),
  ]

  try {
    await wait(warmupMilliseconds)
    wakeUp.resetCounts()
    const cpuStartedAt = process.cpuUsage()
    const wallStartedAt = performance.now()
    await wait(durationMilliseconds)
    const elapsedMilliseconds = performance.now() - wallStartedAt
    const cpuUsage = process.cpuUsage(cpuStartedAt)
    const polls = wakeUp.pollCounts()
    const totalPolls = Object.values(polls).reduce((total, count) => total + count, 0)

    return {
      pollingIntervalMilliseconds,
      idlePollingIntervalMilliseconds: runtime.settings.idlePollingIntervalMilliseconds,
      polls,
      pollsPerSecond: round((totalPolls * 1_000) / elapsedMilliseconds),
      idleCpuPercent: round(
        ((cpuUsage.user + cpuUsage.system) / 1_000 / elapsedMilliseconds) * 100,
      ),
    }
  } finally {
    controller.abort()
    await Promise.all(running)
    await runtime.close()
  }
}

class CountingWakeUpAdapter implements WakeUpAdapter {
  private readonly counts = new Map<WakeUpRole, number>()

  watch(role: WakeUpRole): WakeUpWatch {
    return {
      wait: async ({ timeoutMilliseconds, signal }) => {
        this.counts.set(role, (this.counts.get(role) ?? 0) + 1)
        return new Promise<boolean>((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            signal?.removeEventListener("abort", finish)
            resolve(false)
          }
          const timeout = setTimeout(finish, timeoutMilliseconds)
          signal?.addEventListener("abort", finish, { once: true })
          if (signal?.aborted) finish()
        })
      },
    }
  }

  notify(_role: WakeUpRole): void {}

  close(): void {}

  resetCounts(): void {
    this.counts.clear()
  }

  pollCounts(): Record<WakeUpRole, number> {
    return Object.fromEntries(roles.map((role) => [role, this.counts.get(role) ?? 0])) as Record<
      WakeUpRole,
      number
    >
  }
}

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`
  return (
    process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback
  )
}

function positiveNumber(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be positive`)
  return number
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

await main()

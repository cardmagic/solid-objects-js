import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

interface WorkerResult {
  event: string
  elapsedMilliseconds: number
  maximumTimerGapMilliseconds: number
  ticks: number
  completedAtFirstTick: number
  inputReceived: boolean
  attempts: number[]
  ticksAtLoss: number[]
  completed: number
  count: number
}

async function runWorker(options: {
  scenario: string
  role?: string
  execution?: string
}): Promise<WorkerResult> {
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      fileURLToPath(new URL("./support/register-source-hooks.mjs", import.meta.url)),
      fileURLToPath(new URL("./fixtures/busy-worker.ts", import.meta.url)),
      options.scenario,
      options.role ?? "actors",
      options.execution ?? "run",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  let timedOut = false
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
    if (stdout.includes('"event":"ready"') && !child.stdin.writableEnded) child.stdin.end("input\n")
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.stdin.on("error", () => {})
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 4_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    expect(timedOut, `child exceeded external time limit:\n${stdout}\n${stderr}`).toBe(false)
    expect(code, stderr).toBe(0)
    const result = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkerResult)
      .find((entry) => entry.event === "finished")
    expect(result).toBeDefined()
    return result!
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}

it("lets timers and input run between lost attempts and honors a timer abort", async () => {
  const result = await runWorker({ scenario: "lease-timer" })
  expect(result.ticks).toBeGreaterThan(0)
  expect(result.inputReceived).toBe(true)
  expect(result.ticksAtLoss[1]).toBeGreaterThan(result.ticksAtLoss[0]!)
  expect(result.elapsedMilliseconds).toBeLessThan(2_500)
  expect(result.count).toBe(0)
}, 6_000)

it.each(["lease-callback", "lease-callback-failure", "lease-callback-rejection"])(
  "stops at the third lost attempt when instrumentation aborts %s",
  async (scenario) => {
    const result = await runWorker({ scenario })
    expect(result.attempts).toEqual([1, 2, 3])
    expect(result.elapsedMilliseconds).toBeLessThan(3_000)
    expect(result.count).toBe(0)
  },
  6_000,
)

for (const role of ["actors", "effects", "reminders", "broadcasts"]) {
  for (const execution of ["run", "until-idle", "drain"]) {
    it(`lets timers and input run during continuous ${role} work with ${execution}`, async () => {
      const result = await runWorker({ scenario: "short", role, execution })
      expect(result.completed).toBe(100)
      expect(result.completedAtFirstTick).toBeLessThan(100)
      expect(result.ticks).toBeGreaterThan(0)
      expect(result.inputReceived).toBe(true)
    }, 6_000)
  }
}

it("lets timers and input run while draining due reminders", async () => {
  const result = await runWorker({
    scenario: "short",
    role: "reminders",
    execution: "due-reminders",
  })
  expect(result.completed).toBe(100)
  expect(result.completedAtFirstTick).toBeLessThan(100)
  expect(result.ticks).toBeGreaterThan(0)
  expect(result.inputReceived).toBe(true)
}, 6_000)

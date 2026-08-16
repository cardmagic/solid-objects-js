import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { fork, type ChildProcess } from "node:child_process"
import { createRuntime, type ActorReference, type MessageReference } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { RecoveryCounter } from "./actor.ts"

interface WorkerMessage {
  event: string
  attempt?: number
  processed?: number
}

interface SerializationEvent {
  event: "start" | "finish"
  messageId: string
  at: number
}

interface ExternalEffectEvent {
  messageId: string
  attempt: number
  processId: number
}

const directory = await mkdtemp(join(tmpdir(), "solid-objects-recovery-"))
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
  runtime.register(RecoveryCounter)
  await runtime.install()
  const serialization = await proveSerialization()
  const crash = await proveCrashRecovery()
  const fencing = await proveFencing()
  process.stdout.write(`${JSON.stringify({ serialization, crash, fencing }, null, 2)}\n`)
} finally {
  await runtime.close()
  await rm(directory, { recursive: true })
}

assert.equal(existsSync(directory), false)

async function proveSerialization(): Promise<{ finalState: number; overlap: false }> {
  const controlDirectory = join(directory, "serialization")
  await mkdir(controlDirectory)
  const reference = runtime.ref(RecoveryCounter, "serialized")
  const messages = await Promise.all([
    reference.send.serialize({ controlDirectory }),
    reference.send.serialize({ controlDirectory }),
  ])
  const workers = [spawnWorker(), spawnWorker()]
  await Promise.all(workers.map(({ finished }) => finished))
  await Promise.all(messages.map((message) => message.result()))
  const events = await readJsonLines(
    join(controlDirectory, "serialization.jsonl"),
    parseSerializationEvent,
  )
  assert.equal(events.length, 4)
  const starts = events.filter((event) => event.event === "start")
  const finishes = events.filter((event) => event.event === "finish")
  assert.equal(starts.length, 2)
  assert.equal(finishes.length, 2)
  assert(Number(starts[1]?.at) >= Number(finishes[0]?.at))
  const snapshot = await reference.snapshot()
  assert.equal(snapshot.count, 2)
  return { finalState: snapshot.count, overlap: false }
}

async function proveCrashRecovery(): Promise<{
  attempts: number
  finalState: number
  repeatedEffects: number
}> {
  const controlDirectory = join(directory, "crash")
  await mkdir(controlDirectory)
  const reference = runtime.ref(RecoveryCounter, "crash")
  const message = await reference.send.recover({ controlDirectory })
  const firstWorker = spawnWorker()
  await firstWorker.waitFor((entry) => entry.event === "operation.started" && entry.attempt === 1)
  firstWorker.child.kill("SIGKILL")
  await firstWorker.finished.catch(() => undefined)
  await wait(350)
  const recoveryWorker = spawnWorker()
  await recoveryWorker.finished
  await message.result()
  return recoveryResult({ reference, message, controlDirectory })
}

async function proveFencing(): Promise<{
  attempts: number
  finalState: number
  repeatedEffects: number
}> {
  const controlDirectory = join(directory, "fencing")
  await mkdir(controlDirectory)
  const reference = runtime.ref(RecoveryCounter, "fencing")
  const message = await reference.send.recover({ controlDirectory })
  const staleWorker = spawnWorker()
  await staleWorker.waitFor((entry) => entry.event === "operation.started" && entry.attempt === 1)
  staleWorker.child.kill("SIGSTOP")
  await wait(350)
  const recoveryWorker = spawnWorker()
  await recoveryWorker.finished
  await message.result()
  staleWorker.child.kill("SIGCONT")
  await writeFile(join(controlDirectory, "release-first-attempt"), "")
  await staleWorker.waitFor((entry) => entry.event === "solid_objects.activation.lost")
  await staleWorker.finished
  return recoveryResult({ reference, message, controlDirectory })
}

async function recoveryResult(options: {
  reference: ActorReference<RecoveryCounter>
  message: MessageReference
  controlDirectory: string
}): Promise<{ attempts: number; finalState: number; repeatedEffects: number }> {
  const stored = await runtime.repository.findMessage(options.message.id)
  const attempts = Number(stored?.attempt_count)
  const snapshot = await options.reference.snapshot()
  const effects = await readJsonLines(
    join(options.controlDirectory, "external-effects.jsonl"),
    parseExternalEffectEvent,
  )
  assert.equal(attempts, 2)
  assert.equal(snapshot.count, 1)
  assert.equal(effects.length, 2)
  return { attempts, finalState: snapshot.count, repeatedEffects: effects.length }
}

function spawnWorker(): {
  child: ChildProcess
  finished: Promise<void>
  waitFor(predicate: (message: WorkerMessage) => boolean): Promise<WorkerMessage>
} {
  const child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [databasePath], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const messages: WorkerMessage[] = []
  const listeners = new Set<(message: WorkerMessage) => void>()
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk
  })
  child.on("message", (message: WorkerMessage) => {
    messages.push(message)
    for (const listener of listeners) listener(message)
  })
  const finished = new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`worker exited with code ${code} and signal ${signal}\n${stderr}`))
    })
  })
  return {
    child,
    finished,
    waitFor: (predicate) => {
      const existing = messages.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolvePromise) => {
        const listener = (message: WorkerMessage) => {
          if (!predicate(message)) return
          listeners.delete(listener)
          resolvePromise(message)
        }
        listeners.add(listener)
      })
    },
  }
}

async function readJsonLines<Value>(
  path: string,
  parse: (line: string) => Value,
): Promise<Value[]> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(parse)
}

function parseSerializationEvent(line: string): SerializationEvent {
  const event = JSON.parse(line) as Partial<SerializationEvent>
  if (
    (event.event !== "start" && event.event !== "finish") ||
    typeof event.messageId !== "string" ||
    typeof event.at !== "number"
  ) {
    throw new TypeError("invalid serialization event")
  }
  return { event: event.event, messageId: event.messageId, at: event.at }
}

function parseExternalEffectEvent(line: string): ExternalEffectEvent {
  const event = JSON.parse(line) as Partial<ExternalEffectEvent>
  if (
    typeof event.messageId !== "string" ||
    typeof event.attempt !== "number" ||
    typeof event.processId !== "number"
  ) {
    throw new TypeError("invalid external effect event")
  }
  return {
    messageId: event.messageId,
    attempt: event.attempt,
    processId: event.processId,
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

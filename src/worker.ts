import { randomUUID } from "node:crypto"
import type { SolidObjectsRuntime } from "./runtime.js"

export class Worker {
  readonly processId = randomUUID()
  private registered = false
  private stopping = false

  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async runOnce(): Promise<number> {
    if (this.stopping) return 0
    await this.ensureRegistered()
    await this.runtime.repository.heartbeatProcess(this.processId)
    const turn = await this.runtime.repository.claim(this.processId)
    if (!turn) return 0
    await this.runtime.executeTurn(turn)
    return 1
  }

  async runUntilIdle(options: { maxTurns?: number } = {}): Promise<number> {
    const maxTurns = options.maxTurns ?? 10_000
    let processed = 0
    while (!this.stopping && processed < maxTurns) {
      const count = await this.runOnce()
      if (count === 0) break
      processed += count
    }
    return processed
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureRegistered()
    while (!signal.aborted && !this.stopping) {
      const processed = await this.runOnce()
      if (processed === 0) {
        await waitFor(this.runtime.settings.pollingIntervalMilliseconds, signal)
      }
    }
    await this.stop()
  }

  requestShutdown(): void {
    this.stopping = true
  }

  stopped(): boolean {
    return this.stopping
  }

  async stop(): Promise<void> {
    if (this.stopping && !this.registered) return
    this.stopping = true
    if (this.registered) {
      await this.runtime.repository.stopProcess(this.processId)
      this.registered = false
    }
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) return
    await this.runtime.repository.registerProcess(this.processId, "worker")
    this.registered = true
  }
}

export function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

export async function withProcessHeartbeat<Result>(options: {
  runtime: SolidObjectsRuntime
  processId: string
  operation: () => Promise<Result>
}): Promise<Result> {
  const { runtime, processId, operation } = options
  const controller = new AbortController()
  let heartbeatError: unknown
  const heartbeat = heartbeatUntilStopped({ runtime, processId, signal: controller.signal }).catch(
    (error: unknown) => {
      heartbeatError = error
    },
  )
  try {
    const result = await operation()
    controller.abort()
    await heartbeat
    if (heartbeatError) throw heartbeatError
    return result
  } finally {
    controller.abort()
    await heartbeat
  }
}

async function heartbeatUntilStopped(options: {
  runtime: SolidObjectsRuntime
  processId: string
  signal: AbortSignal
}): Promise<void> {
  const { runtime, processId, signal } = options
  while (!signal.aborted) {
    await waitFor(runtime.settings.processHeartbeatIntervalMilliseconds, signal)
    if (signal.aborted) return
    await runtime.repository.heartbeatProcess(processId)
  }
}

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
    let turn = await this.runtime.repository.claim(this.processId)
    if (!turn) return 0
    const firstTurn = turn
    let processed = 0
    while (turn && processed < this.runtime.settings.maxMessagesPerActivationPass) {
      await this.runtime.executeTurn(turn)
      processed += 1
      if (processed >= this.runtime.settings.maxMessagesPerActivationPass) break
      turn = await this.runtime.repository.claim(this.processId, {
        instanceId: firstTurn.instance.id,
      })
    }
    if (processed >= this.runtime.settings.maxMessagesPerActivationPass) {
      const yielded = await this.runtime.repository.yieldReadyMessages(firstTurn.instance.id)
      if (yielded > 0) {
        this.runtime.emitInstrumentation("activation.yielded", {
          actorType: firstTurn.message.actor_type,
          actorId: firstTurn.message.actor_id,
          processed,
          readyMessages: yielded,
        })
      }
    }
    return processed
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
      const wakeUp = await this.runtime.settings.wakeUp.watch("actors")
      const processed = await this.runOnce()
      if (processed === 0) {
        await wakeUp.wait({
          timeoutMilliseconds: this.runtime.settings.pollingIntervalMilliseconds,
          signal,
        })
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

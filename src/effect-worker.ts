import { randomUUID } from "node:crypto"
import type { SolidObjectsRuntime } from "./runtime.js"
import { withProcessHeartbeat } from "./worker.js"

export class EffectWorker {
  readonly processId = randomUUID()
  private registered = false
  private stopping = false

  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async runOnce(): Promise<number> {
    if (this.stopping) return 0
    await this.ensureRegistered()
    await this.runtime.repository.heartbeatProcess(this.processId)
    const effect = await this.runtime.repository.claimEffect(this.processId)
    if (!effect) return 0
    await withProcessHeartbeat({
      runtime: this.runtime,
      processId: this.processId,
      operation: () => this.runtime.executeEffect(effect),
    })
    return 1
  }

  async runUntilIdle(options: { maxEffects?: number } = {}): Promise<number> {
    const maxEffects = options.maxEffects ?? 10_000
    let processed = 0
    while (!this.stopping && processed < maxEffects) {
      const count = await this.runOnce()
      if (count === 0) break
      processed += count
    }
    return processed
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureRegistered()
    while (!signal.aborted && !this.stopping) {
      const wakeUp = await this.runtime.settings.wakeUp.watch("effects")
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
    if (!this.registered) return
    await this.runtime.repository.stopProcess(this.processId)
    this.registered = false
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) return
    await this.runtime.repository.registerProcess(this.processId, "effect_worker")
    this.registered = true
  }
}

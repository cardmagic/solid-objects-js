import { randomUUID } from "./platform/uuid.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import { withProcessHeartbeat } from "./worker.js"
import { PollingBackoff } from "./polling-backoff.js"

export class BroadcastWorker {
  readonly processId = randomUUID()
  private registered = false
  private stopping = false
  private readonly pollingBackoff: PollingBackoff

  constructor(private readonly runtime: SolidObjectsRuntime) {
    this.pollingBackoff = new PollingBackoff({
      minimumIntervalMilliseconds: runtime.settings.pollingIntervalMilliseconds,
      maximumIntervalMilliseconds: runtime.settings.idlePollingIntervalMilliseconds,
      onChange: (transition) =>
        runtime.emitInstrumentation("polling.interval_changed", {
          role: "broadcasts",
          ...transition,
        }),
    })
  }

  get currentPollingIntervalMilliseconds(): number {
    return this.pollingBackoff.currentIntervalMilliseconds
  }

  async runOnce(): Promise<number> {
    if (this.stopping) return 0
    await this.ensureRegistered()
    await this.runtime.repository.heartbeatProcess(this.processId)
    const broadcast = await this.runtime.repository.claimBroadcast(this.processId)
    if (!broadcast) return 0
    await withProcessHeartbeat({
      runtime: this.runtime,
      processId: this.processId,
      operation: () => this.runtime.executeBroadcast(broadcast),
    })
    return 1
  }

  async runUntilIdle(options: { maxBroadcasts?: number } = {}): Promise<number> {
    const maxBroadcasts = options.maxBroadcasts ?? 10_000
    let processed = 0
    while (!this.stopping && processed < maxBroadcasts) {
      const count = await this.runOnce()
      if (count === 0) break
      processed += count
    }
    return processed
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureRegistered()
    await this.runtime.warnIfPollingIsOnlyCrossProcessWakeUp()
    while (!signal.aborted && !this.stopping) {
      const wakeUp = await this.runtime.settings.wakeUp.watch("broadcasts")
      const processed = await this.runOnce()
      if (processed > 0) {
        this.pollingBackoff.reset("work")
        continue
      }
      const notified = await wakeUp.wait({
        timeoutMilliseconds: this.pollingBackoff.currentIntervalMilliseconds,
        signal,
      })
      if (notified === false) this.pollingBackoff.recordIdle()
      else this.pollingBackoff.reset("wake_up")
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
    await this.runtime.repository.startDrainingProcess(this.processId)
    await this.runtime.repository.stopProcess(this.processId)
    this.registered = false
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) return
    await this.runtime.repository.registerProcess(this.processId, "broadcast_worker")
    this.registered = true
  }
}

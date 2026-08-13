import type { SolidObjectsRuntime } from "./runtime.js"
import { waitFor } from "./worker.js"

export class MaintenanceScheduler {
  private stopping = false

  constructor(
    private readonly options: {
      runtime: SolidObjectsRuntime
      intervalMilliseconds: number
      failureEvent: string
      operation: () => Promise<void>
    },
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    let failureCount = 0
    while (!signal.aborted && !this.stopping) {
      try {
        await this.options.operation()
        failureCount = 0
      } catch (error) {
        failureCount += 1
        this.options.runtime.emitInstrumentation(this.options.failureEvent, {
          errorName: error instanceof Error ? error.name : "Error",
          failureCount,
        })
      }
      await waitFor(this.pauseMilliseconds(failureCount), signal)
    }
  }

  requestShutdown(): void {
    this.stopping = true
  }

  stopped(): boolean {
    return this.stopping
  }

  stop(): void {
    this.stopping = true
  }

  private pauseMilliseconds(failureCount: number): number {
    if (failureCount === 0) return this.options.intervalMilliseconds
    const exponent = Math.min(failureCount - 1, 16)
    return Math.min(
      this.options.runtime.settings.supervisorRestartDelayMilliseconds * 2 ** exponent,
      this.options.runtime.settings.supervisorMaximumRestartDelayMilliseconds,
      this.options.intervalMilliseconds,
    )
  }
}

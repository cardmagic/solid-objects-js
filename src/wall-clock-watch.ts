import { waitFor } from "./worker.js"

export const WALL_CLOCK_WATCH_INTERVAL_MILLISECONDS = 10_000
export const WALL_CLOCK_JUMP_MILLISECONDS = 1_000

export class WallClockWatch {
  private stopping = false

  constructor(private readonly options: { onJump: () => void }) {}

  async run(signal: AbortSignal): Promise<void> {
    let offset = wallClockOffset()
    while (!signal.aborted && !this.stopping) {
      await waitFor(WALL_CLOCK_WATCH_INTERVAL_MILLISECONDS, signal)
      if (signal.aborted || this.stopping) return
      const current = wallClockOffset()
      if (Math.abs(current - offset) >= WALL_CLOCK_JUMP_MILLISECONDS) this.options.onJump()
      offset = current
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
}

function wallClockOffset(): number {
  return Date.now() - performance.now()
}

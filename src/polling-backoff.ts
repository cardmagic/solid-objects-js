export type PollingBackoffReason = "idle" | "wake_up" | "work"

export interface PollingBackoffTransition {
  previousIntervalMilliseconds: number
  currentIntervalMilliseconds: number
  reason: PollingBackoffReason
}

export interface PollingBackoffOptions {
  minimumIntervalMilliseconds: number
  maximumIntervalMilliseconds: number
  onChange?: (transition: PollingBackoffTransition) => void
}

export class PollingBackoff {
  private intervalMilliseconds: number
  private readonly minimumIntervalMilliseconds: number
  private readonly maximumIntervalMilliseconds: number
  private readonly onChange: ((transition: PollingBackoffTransition) => void) | undefined

  constructor(options: PollingBackoffOptions) {
    this.minimumIntervalMilliseconds = options.minimumIntervalMilliseconds
    this.intervalMilliseconds = options.minimumIntervalMilliseconds
    this.maximumIntervalMilliseconds = Math.max(
      options.minimumIntervalMilliseconds,
      options.maximumIntervalMilliseconds,
    )
    this.onChange = options.onChange
  }

  get currentIntervalMilliseconds(): number {
    return this.intervalMilliseconds
  }

  recordIdle(): void {
    this.change(Math.min(this.intervalMilliseconds * 2, this.maximumIntervalMilliseconds), "idle")
  }

  reset(reason: Exclude<PollingBackoffReason, "idle">): void {
    this.change(this.minimumIntervalMilliseconds, reason)
  }

  private change(intervalMilliseconds: number, reason: PollingBackoffReason): void {
    if (intervalMilliseconds === this.intervalMilliseconds) return
    const previousIntervalMilliseconds = this.intervalMilliseconds
    this.intervalMilliseconds = intervalMilliseconds
    this.onChange?.({
      previousIntervalMilliseconds,
      currentIntervalMilliseconds: intervalMilliseconds,
      reason,
    })
  }
}

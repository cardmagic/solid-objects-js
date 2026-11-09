import type { RuntimeSettings } from "./configuration.js"

export const MAXIMUM_WAIT_MILLISECONDS = 86_400_000

export class DueWait {
  private retryMilliseconds = 1

  milliseconds(options: {
    untilDueMilliseconds: number | undefined
    pollingIntervalMilliseconds: number
  }): number {
    if (options.untilDueMilliseconds === undefined) return this.reset(MAXIMUM_WAIT_MILLISECONDS)
    if (options.untilDueMilliseconds > 0) {
      return this.reset(Math.min(options.untilDueMilliseconds + 1, MAXIMUM_WAIT_MILLISECONDS))
    }
    const retry = Math.min(this.retryMilliseconds, options.pollingIntervalMilliseconds)
    this.retryMilliseconds = Math.min(
      this.retryMilliseconds * 2,
      options.pollingIntervalMilliseconds,
    )
    return retry
  }

  private reset(milliseconds: number): number {
    this.retryMilliseconds = 1
    return milliseconds
  }
}

export async function idleWaitMilliseconds(options: {
  settings: RuntimeSettings
  pollingIntervalMilliseconds: number
  dueWait: DueWait
  untilDue: () => Promise<number | undefined>
}): Promise<number> {
  if (!options.settings.singleOwner) return options.pollingIntervalMilliseconds
  return options.dueWait.milliseconds({
    untilDueMilliseconds: await options.untilDue(),
    pollingIntervalMilliseconds: options.pollingIntervalMilliseconds,
  })
}

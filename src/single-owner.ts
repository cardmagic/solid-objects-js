import type { RuntimeSettings } from "./configuration.js"

export const MAXIMUM_WAIT_MILLISECONDS = 86_400_000

export function waitUntilDue(options: {
  untilDueMilliseconds: number | undefined
  pollingIntervalMilliseconds: number
}): number {
  if (options.untilDueMilliseconds === undefined) return MAXIMUM_WAIT_MILLISECONDS
  if (options.untilDueMilliseconds < 0) return options.pollingIntervalMilliseconds
  return Math.min(options.untilDueMilliseconds + 1, MAXIMUM_WAIT_MILLISECONDS)
}

export async function idleWaitMilliseconds(options: {
  settings: RuntimeSettings
  pollingIntervalMilliseconds: number
  untilDue: () => Promise<number | undefined>
}): Promise<number> {
  if (!options.settings.singleOwner) return options.pollingIntervalMilliseconds
  return waitUntilDue({
    untilDueMilliseconds: await options.untilDue(),
    pollingIntervalMilliseconds: options.pollingIntervalMilliseconds,
  })
}

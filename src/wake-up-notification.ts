import type { Logger } from "./types.js"
import type { WakeUpAdapter, WakeUpRole } from "./wake-up.js"

export function notifyWakeUp(options: {
  adapter: WakeUpAdapter
  logger: Logger
  role: WakeUpRole
}): void {
  const logFailure = (errorName: string): void => {
    options.logger.error({ event: "solid_objects.wake_up.failed", role: options.role, errorName })
  }
  try {
    Promise.resolve(options.adapter.notify(options.role)).catch((error) =>
      logFailure(error instanceof Error ? error.name : "Error"),
    )
  } catch (error) {
    logFailure(error instanceof Error ? error.name : "Error")
  }
}

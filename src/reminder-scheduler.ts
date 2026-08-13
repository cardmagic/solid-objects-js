import { randomUUID } from "node:crypto"
import { UnknownOperation } from "./errors.js"
import type { SolidObjectsRuntime } from "./runtime.js"

export class ReminderScheduler {
  readonly processId = randomUUID()
  private registered = false
  private stopping = false

  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async runOnce(): Promise<number> {
    if (this.stopping) return 0
    await this.ensureRegistered()
    await this.runtime.repository.heartbeatProcess(this.processId)
    const reminder = await this.runtime.repository.claimReminder(this.processId)
    if (!reminder) return 0
    try {
      await this.runtime.executeReminder(reminder)
    } catch (error) {
      if (error instanceof UnknownOperation) {
        await this.runtime.repository.failReminder(reminder, error)
        this.runtime.settings.logger.error({
          event: "solid_objects.reminder_paused",
          reminderId: reminder.id,
          actorType: reminder.actor_type,
          actorId: reminder.actor_id,
          operation: reminder.operation,
          error: error.message,
        })
        return 1
      }
      await this.runtime.repository.releaseReminder(reminder)
      throw error
    }
    return 1
  }

  async runUntilIdle(options: { maxReminders?: number } = {}): Promise<number> {
    const maxReminders = options.maxReminders ?? 10_000
    let processed = 0
    while (!this.stopping && processed < maxReminders) {
      const count = await this.runOnce()
      if (count === 0) break
      processed += count
    }
    return processed
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureRegistered()
    while (!signal.aborted && !this.stopping) {
      const wakeUp = await this.runtime.settings.wakeUp.watch("reminders")
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
    await this.runtime.repository.registerProcess(this.processId, "reminder_scheduler")
    this.registered = true
  }
}

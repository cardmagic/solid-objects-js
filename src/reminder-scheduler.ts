import { randomUUID } from "node:crypto"
import { UnknownOperation } from "./errors.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import { PollingBackoff } from "./polling-backoff.js"

export class ReminderScheduler {
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
          role: "reminders",
          ...transition,
        }),
    })
  }

  get currentPollingIntervalMilliseconds(): number {
    return this.pollingBackoff.currentIntervalMilliseconds
  }

  async runOnce(options: { now?: Date } = {}): Promise<number> {
    if (this.stopping) return 0
    const nowMilliseconds = options.now?.getTime()
    if (nowMilliseconds !== undefined && !Number.isFinite(nowMilliseconds)) {
      throw new TypeError("reminder test time must be a valid date")
    }
    await this.ensureRegistered()
    await this.runtime.repository.heartbeatProcess(this.processId)
    const reminder = await this.runtime.repository.claimReminder(this.processId, {
      ...(nowMilliseconds === undefined ? {} : { nowMilliseconds }),
    })
    if (!reminder) return 0
    try {
      await this.runtime.executeReminder(reminder, {
        ...(nowMilliseconds === undefined ? {} : { nowMilliseconds }),
      })
    } catch (error) {
      if (error instanceof UnknownOperation) {
        await this.runtime.repository.failReminder(reminder, error)
        this.runtime.settings.logger.error({
          event: "solid_objects.reminder_paused",
          reminderId: reminder.id,
          actorType: reminder.actor_type,
          actorId: reminder.actor_id,
          operation: reminder.message_operation ?? reminder.operation,
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
    await this.runtime.warnIfPollingIsOnlyCrossProcessWakeUp()
    while (!signal.aborted && !this.stopping) {
      const wakeUp = await this.runtime.settings.wakeUp.watch("reminders")
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
    await this.runtime.repository.registerProcess(this.processId, "reminder_scheduler")
    this.registered = true
  }
}

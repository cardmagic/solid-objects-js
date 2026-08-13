import type { SolidObjectsRuntime } from "./runtime.js"
import type { AdministrationOptions } from "./types.js"

export type ReminderStatus = "scheduled" | "paused" | "completed"

export interface ReminderRecord {
  readonly id: string
  readonly actorType: string
  readonly actorId: string
  readonly operation: string
  readonly runAt: Date
  readonly intervalMilliseconds: number | null
  readonly missedPolicy: "latest" | "all"
  readonly occurrence: number
  readonly status: ReminderStatus
  readonly errorName: string | null
}

export interface ReminderPage {
  readonly items: readonly ReminderRecord[]
  readonly nextCursor: string | null
}

export interface ReminderPageOptions extends AdministrationOptions {
  actorType?: string
  status?: ReminderStatus
  cursor?: string
  limit?: number
}

export interface ResumeReminderOptions extends AdministrationOptions {
  runAt?: Date
}

export class ReminderManager {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  all(options: ReminderPageOptions = {}): Promise<ReminderPage> {
    return this.runtime.inspectReminders(options)
  }

  resume(id: string, options: ResumeReminderOptions = {}): Promise<ReminderRecord> {
    return this.runtime.resumeReminder(id, options)
  }
}

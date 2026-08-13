import type { SolidObjectsRuntime } from "./runtime.js"
import type { AdministrationOptions } from "./types.js"

export type RetentionTarget = "messages" | "instances" | "processes"

export interface RetentionOptions extends AdministrationOptions {
  target: RetentionTarget
}

export interface RetentionResult {
  readonly target: RetentionTarget
  readonly count: number
}

export class RetentionManager {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  preview(options: RetentionOptions): Promise<RetentionResult> {
    return this.runtime.previewRetention(options)
  }

  prune(options: RetentionOptions): Promise<RetentionResult> {
    return this.runtime.pruneRetention(options)
  }
}

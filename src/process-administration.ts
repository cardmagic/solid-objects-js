import type { SolidObjectsRuntime } from "./runtime.js"
import type { AdministrationOptions } from "./types.js"

export type ProcessShutdownState = "running" | "draining" | "stopped"

export interface ProcessMetadata {
  readonly solidObjectsVersion: string
  readonly nodeVersion: string
}

export interface ProcessRecord {
  readonly id: string
  readonly kind: string
  readonly hostname: string
  readonly hostProcessId: number
  readonly metadata: ProcessMetadata
  readonly shutdownState: ProcessShutdownState
  readonly shutdownRequestedAt: Date | null
  readonly stale: boolean
  readonly startedAt: Date
  readonly heartbeatAt: Date
  readonly stoppedAt: Date | null
}

export interface ProcessCleanupResult {
  readonly cleaned: number
}

export class ProcessManager {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  all(options: AdministrationOptions = {}): Promise<readonly ProcessRecord[]> {
    return this.runtime.inspectProcesses(options)
  }

  cleanup(options: AdministrationOptions = {}): Promise<ProcessCleanupResult> {
    return this.runtime.cleanupProcesses(options)
  }
}

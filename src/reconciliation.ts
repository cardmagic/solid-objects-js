import type { SolidObjectsRuntime } from "./runtime.js"
import type { ActorIdentifier, AdministrationOptions, DeepReadonly, JsonObject } from "./types.js"

export interface ReconciliationInstance {
  readonly id: string
  readonly actorType: string
  readonly actorId: string
  readonly stateVersion: number
  readonly revision: string
  readonly status: "active" | "paused"
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ReconciliationPage {
  readonly items: readonly ReconciliationInstance[]
  readonly nextCursor: string | null
}

export interface ReconciliationPageOptions extends AdministrationOptions {
  actorType?: string
  cursor?: string
  limit?: number
}

export interface QuietReconciliationOptions extends ReconciliationPageOptions {
  quietForMilliseconds: number
}

export interface ReconciliationStatesOptions extends AdministrationOptions {
  actorType: string
  actorIds: readonly ActorIdentifier[]
}

export interface OrphanedReconciliationOptions extends ReconciliationPageOptions {
  actorType: string
  ownerIds: readonly ActorIdentifier[]
}

export class ReconciliationManager {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  active(options: ReconciliationPageOptions = {}): Promise<ReconciliationPage> {
    return this.runtime.activeInstances(options)
  }

  withoutPendingWork(options: QuietReconciliationOptions): Promise<ReconciliationPage> {
    return this.runtime.instancesWithoutPendingWork(options)
  }

  statesFor(
    options: ReconciliationStatesOptions,
  ): Promise<DeepReadonly<Record<string, JsonObject>>> {
    return this.runtime.instanceStatesFor(options)
  }

  orphaned(options: OrphanedReconciliationOptions): Promise<ReconciliationPage> {
    return this.runtime.orphanedInstances(options)
  }
}

import { DeadLetterScope, type DeadLetterKind } from "./dead-letter-scopes.js"
import type { MessageReference } from "./reference.js"
import type { SolidObjectsRuntime } from "./runtime.js"
import type { AdministrationOptions, DeepReadonly, JsonObject, JsonValue } from "./types.js"

export interface DeadLetter {
  readonly id: string
  readonly messageId: string
  readonly actorType: string
  readonly actorId: string
  readonly operation: string
  readonly deliveryMode: "async" | "sync" | "internal"
  readonly arguments: DeepReadonly<JsonObject>
  readonly attempts: number
  readonly error: DeepReadonly<Record<string, JsonValue>>
  readonly createdAt: Date
  readonly retriedMessageId: string | null
}

export class DeadLetterManager {
  private readonly scopes = new Map<DeadLetterKind, DeadLetterScope>()

  constructor(private readonly runtime: SolidObjectsRuntime) {}

  all(options: AdministrationOptions = {}): Promise<readonly DeadLetter[]> {
    return this.runtime.inspectDeadLetters(options)
  }

  retry(id: string, options: AdministrationOptions = {}): Promise<MessageReference> {
    return this.runtime.retryDeadLetter(id, options)
  }

  get effects(): DeadLetterScope {
    return this.scope("effect")
  }

  get broadcasts(): DeadLetterScope {
    return this.scope("broadcast")
  }

  scope(kind: DeadLetterKind): DeadLetterScope {
    const existing = this.scopes.get(kind)
    if (existing) return existing

    const created = new DeadLetterScope(this.runtime, kind)
    this.scopes.set(kind, created)
    return created
  }
}

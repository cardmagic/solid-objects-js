import type { MessageReference } from "./reference.js"

export class SolidObjectsError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}
export class NonRetryableError extends SolidObjectsError {}
export class UnsupportedDatabase extends SolidObjectsError {}
export class DatabaseDeadlineExceeded extends SolidObjectsError {}
export class SyncEnqueueTimeout extends SolidObjectsError {
  constructor(
    readonly details: {
      timeoutMilliseconds: number
      actorType: string
      actorId: string
      operation: string
    },
  ) {
    super(
      `actor invocation could not be durably enqueued within ` +
        `${details.timeoutMilliseconds}ms for ` +
        `${details.actorType}(${JSON.stringify(details.actorId)}).${details.operation}`,
    )
  }
}
export class InvalidActor extends SolidObjectsError {}
export class UnknownActorType extends NonRetryableError {}
export class UnknownOperation extends NonRetryableError {}
export class InvalidPayload extends SolidObjectsError {}
export class PayloadTooLarge extends InvalidPayload {}
export class MailboxFull extends SolidObjectsError {}
export class IdempotencyConflict extends SolidObjectsError {}
export class Unauthorized extends SolidObjectsError {}
export class LostActivation extends SolidObjectsError {}
export class ActorDestroyed extends LostActivation {}
export class StateMigrationError extends NonRetryableError {}
export class ActorCallCycle extends NonRetryableError {}
export class QueryMutatedState extends NonRetryableError {}
export class ApplicationWriteForbidden extends NonRetryableError {}
export class UnknownEffect extends NonRetryableError {}
export class UnknownCommitAction extends NonRetryableError {}
export class UnknownDeadLetter extends SolidObjectsError {}
export class UnknownReminder extends SolidObjectsError {}
export class ReminderNotPaused extends SolidObjectsError {}
export class InvalidStreamToken extends SolidObjectsError {}
export class InvalidComponentToken extends SolidObjectsError {}
export class UnknownComponent extends SolidObjectsError {}
export class UnknownComponentDependency extends SolidObjectsError {}
export class InvalidPayloadBroadcast extends SolidObjectsError {}
export class UnknownPayloadBroadcast extends SolidObjectsError {}

export class Rejected extends SolidObjectsError {
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>
  messageId?: string

  constructor(options: { code: string; message: string; details?: Record<string, unknown> }) {
    super(options.message)
    this.code = options.code
    this.details = Object.freeze({ ...(options.details ?? {}) })
  }
}

export class SyncTimeout extends SolidObjectsError {
  readonly details: SyncTimeoutDetails
  readonly messageReference: MessageReference

  constructor(options: { details: SyncTimeoutDetails; messageReference: MessageReference }) {
    const { details } = options
    super(
      `actor invocation timed out after ${details.timeoutMilliseconds}ms for ` +
        `${details.actorType}(${JSON.stringify(details.actorId)}).${details.operation} ` +
        `messageId=${details.messageId} sequence=${details.sequence} ` +
        `status=${details.status} waitingOn=${details.waitingOn}`,
    )
    this.details = Object.freeze(details)
    this.messageReference = options.messageReference
  }
}

export type SyncTimeoutWaitingOn =
  | "actorPaused"
  | "activationHeld"
  | "earlierMessage"
  | "messageClaimed"
  | "notYetAvailable"
  | "readyUnclaimed"
  | "databaseContention"
  | "unknown"

export interface SyncTimeoutDetails {
  readonly timeoutMilliseconds: number
  readonly actorType: string
  readonly actorId: string
  readonly operation: string
  readonly messageId: string
  readonly requestId: string
  readonly sequence: bigint
  readonly status: string
  readonly waitingOn: SyncTimeoutWaitingOn
  readonly activation: Readonly<{
    ownerId: string | null
    generation: bigint
    expiresAt: Date | null
    process: Readonly<{
      kind: string
      heartbeatAt: Date
      shutdownState: string
    }> | null
  }>
  readonly blocker: Readonly<{
    messageId: string
    sequence: bigint
    operation: string
    status: string
  }> | null
}

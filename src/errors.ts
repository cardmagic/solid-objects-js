export class SolidObjectsError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}
export class NonRetryableError extends SolidObjectsError {}
export class UnsupportedDatabase extends SolidObjectsError {}
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
  constructor(
    readonly details: {
      timeoutMilliseconds: number
      actorType: string
      actorId: string
      operation: string
      messageId: string
      requestId: string
      sequence: bigint
      status: string
    },
  ) {
    super(
      `actor invocation timed out after ${details.timeoutMilliseconds}ms for ` +
        `${details.actorType}(${JSON.stringify(details.actorId)}).${details.operation}`,
    )
  }
}

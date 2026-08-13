import type { Actor, ActorClass } from "./actor.js"
import { BroadcastWorker } from "./broadcast-worker.js"
import {
  buildSettings,
  broadcastsEnabled,
  validateComponent,
  type BroadcastEvent,
  type ComponentRegistration,
  type SolidObjectsConfiguration,
} from "./configuration.js"
import { currentActor, withActorContext, withActorProjection } from "./context.js"
import { DeadLetterManager, type DeadLetter } from "./dead-letters.js"
import { Doctor } from "./doctor.js"
import { clearDefaultRuntime, setDefaultRuntime } from "./default-runtime.js"
import {
  actorState,
  hydrateActor,
  initialStateFor,
  migrateState,
  validateDefinition,
  type ValidatedActorDefinition,
} from "./definition.js"
import {
  ActorCallCycle,
  ActorDestroyed,
  DatabaseDeadlineExceeded,
  InvalidPayloadBroadcast,
  InvalidActor,
  LostActivation,
  MessageFailed,
  NonRetryableError,
  QueryMutatedState,
  Rejected,
  SyncTimeout,
  SyncEnqueueTimeout,
  SyncInsideTransaction,
  Unauthorized,
  UnknownCommitAction,
  UnknownDeadLetter,
  UnknownEffect,
  UnknownActorType,
  UnknownOperation,
  UnknownPayloadBroadcast,
} from "./errors.js"
import {
  ActorReferenceCore,
  createActorReference,
  MessageReference,
  type ActorReference,
  type ActorSnapshot,
} from "./reference.js"
import {
  ReconciliationManager,
  type OrphanedReconciliationOptions,
  type QuietReconciliationOptions,
  type ReconciliationInstance,
  type ReconciliationPage,
  type ReconciliationPageOptions,
  type ReconciliationStatesOptions,
} from "./reconciliation.js"
import { Repository } from "./repository.js"
import {
  ProcessManager,
  type ProcessCleanupResult,
  type ProcessRecord,
} from "./process-administration.js"
import { RealtimeManager } from "./realtime.js"
import type { PayloadEnvelope } from "./browser/index.js"
import { MaintenanceScheduler } from "./maintenance-scheduler.js"
import type {
  BroadcastRow,
  ClaimedTurn,
  DeadLetterRow,
  EffectRow,
  InstanceRow,
  MessageRow,
  ReminderRow,
} from "./records.js"
import { ReminderScheduler } from "./reminder-scheduler.js"
import {
  ReminderManager,
  type ReminderPage,
  type ReminderPageOptions,
  type ReminderRecord,
  type ResumeReminderOptions,
} from "./reminder-administration.js"
import { RetentionManager, type RetentionOptions, type RetentionResult } from "./retention.js"
import { deepCopy, jsonObject, normalizeJson, readonlyCopy, stableJson } from "./serialization.js"
import { installSchema } from "./schema.js"
import type {
  ActorIdentifier,
  AdministrationOptions,
  AsyncInvocationOptions,
  CommitActionContext,
  DeepReadonly,
  DestroyOptions,
  EffectContext,
  InvocationOptions,
  JsonObject,
  JsonValue,
  LongRunningComponent,
  MessageContext,
  MessageStatus,
  SnapshotOptions,
} from "./types.js"
import { SolidObjectsTestHelper } from "./test-helper.js"
import { waitFor, Worker } from "./worker.js"
import { EffectWorker } from "./effect-worker.js"
import type { WakeUpRole } from "./wake-up.js"
import { withDatabaseDeadline } from "./database/deadline.js"

interface RegisteredActor {
  actorClass: ActorClass
  definition: ValidatedActorDefinition
  operations: ReadonlySet<string>
  queries: ReadonlySet<string>
}

interface PayloadProjectionSnapshot {
  state: JsonObject
  instanceId: string
  revision: string
}

interface ComponentSlot {
  readonly factory: () => LongRunningComponent
  component: LongRunningComponent
  cleanupAttempted: boolean
}

type ComponentRunOutcome =
  { status: "fulfilled" } | { status: "rejected"; error: unknown } | { status: "timeout" }

type EffectHandler = (
  argumentsValue: JsonObject,
  context: EffectContext,
) => unknown | Promise<unknown>
type CommitActionHandler = (
  argumentsValue: JsonObject,
  context: CommitActionContext,
) => unknown | Promise<unknown>

export class SolidObjectsRuntime {
  readonly settings
  readonly repository
  readonly deadLetters
  readonly reconciliation
  readonly retention
  readonly doctor
  readonly testing
  readonly reminders
  readonly realtime
  readonly processes
  private readonly registry = new Map<string, RegisteredActor>()
  private readonly effects = new Map<string, EffectHandler>()
  private readonly commitActions = new Map<string, CommitActionHandler>()
  private readonly additionalComponents: ComponentRegistration[] = []
  private callerWorker: Worker | undefined
  private running = false

  constructor(configuration: SolidObjectsConfiguration) {
    this.settings = buildSettings(configuration)
    this.repository = new Repository(this.settings)
    this.deadLetters = new DeadLetterManager(this)
    this.reconciliation = new ReconciliationManager(this)
    this.retention = new RetentionManager(this)
    this.doctor = new Doctor(this)
    this.testing = new SolidObjectsTestHelper(this)
    this.reminders = new ReminderManager(this)
    this.realtime = new RealtimeManager(this)
    this.processes = new ProcessManager(this)
  }

  async install(): Promise<void> {
    await this.settings.database.transaction((connection) =>
      installSchema({
        connection,
        family: this.settings.database.family,
        prefix: this.settings.tableNamePrefix,
        schemaIdentity: this.settings.database.schemaIdentity,
      }),
    )
  }

  register<ActorType extends Actor>(actorClass: ActorClass<ActorType>): ActorClass<ActorType> {
    const existing = this.registry.get(actorClass.actorType)
    if (existing?.actorClass === actorClass) return actorClass
    const definition = validateDefinition(actorClass)
    const conflicting = this.registry.get(definition.type)
    if (conflicting && conflicting.actorClass !== actorClass) {
      throw new InvalidActor(`actor type ${definition.type} is already registered`)
    }
    const operations = new Set(definition.operations)
    const queries = new Set(definition.queries)
    this.registry.set(definition.type, { actorClass, definition, operations, queries })
    return actorClass
  }

  ref<ActorType extends Actor>(
    actorClass: ActorClass<ActorType>,
    actorId: ActorIdentifier,
  ): ActorReference<ActorType> {
    this.register(actorClass)
    const entry = this.registry.get(actorClass.actorType)
    if (!entry) throw new UnknownActorType(actorClass.actorType)
    return createActorReference({
      runtime: this,
      actorClass,
      actorType: entry.definition.type,
      actorId: String(actorId),
      operations: entry.operations,
      queries: entry.queries,
    })
  }

  registerEffect(name: string, handler: EffectHandler): void {
    if (this.effects.has(name)) throw new TypeError(`effect ${name} is already registered`)
    this.effects.set(name, handler)
  }

  registerCommitAction(name: string, handler: CommitActionHandler): void {
    if (this.commitActions.has(name))
      throw new TypeError(`commit action ${name} is already registered`)
    this.commitActions.set(name, handler)
  }

  registerComponent(factory: () => LongRunningComponent, options: { count?: number } = {}): void {
    const count = options.count ?? 1
    if (!Number.isSafeInteger(count) || count < 1)
      throw new TypeError("component count must be positive")
    this.additionalComponents.push({ count, factory })
  }

  worker(): Worker {
    return new Worker(this)
  }

  effectWorker(): EffectWorker {
    return new EffectWorker(this)
  }

  reminderScheduler(): ReminderScheduler {
    return new ReminderScheduler(this)
  }

  broadcastWorker(): BroadcastWorker {
    if (!broadcastsEnabled(this.settings))
      throw new TypeError("realtime delivery is not configured")
    return new BroadcastWorker(this)
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Solid Objects runtime is already running")
    if (signal.aborted) return
    this.running = true
    this.emitInstrumentation("runtime.started", {
      workerCount: this.settings.workerCount,
      effectWorkerCount: this.settings.effectWorkerCount,
      reminderSchedulerCount: this.settings.reminderSchedulerCount,
      broadcastWorkerCount: broadcastsEnabled(this.settings)
        ? this.settings.broadcastWorkerCount
        : 0,
      retentionEnabled: this.settings.retentionIntervalMilliseconds > 0,
      deadProcessCleanupEnabled: this.settings.deadProcessCleanupIntervalMilliseconds > 0,
    })
    const controller = new AbortController()
    let shutdownDeadline: number | undefined
    const abort = () => {
      shutdownDeadline ??= performance.now() + this.settings.shutdownTimeoutMilliseconds
      controller.abort(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    let slots: ComponentSlot[] = []

    try {
      slots = await this.buildComponentSlots()
      await Promise.all(
        slots.map((slot) =>
          this.supervise({
            slot,
            signal: controller.signal,
            shutdownDeadline: () => shutdownDeadline,
          }),
        ),
      )
    } finally {
      abort()
      await Promise.allSettled(
        slots
          .filter(({ cleanupAttempted }) => !cleanupAttempted)
          .map(({ component }) =>
            this.stopComponent(component, {
              shutdown: {
                signal: controller.signal,
                deadline: () => shutdownDeadline,
              },
            }),
          ),
      )
      signal.removeEventListener("abort", abort)
      this.running = false
      this.emitInstrumentation("runtime.stopped", {})
    }
  }

  async sendMessage<Result = unknown>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue?: JsonObject
    options?: AsyncInvocationOptions
  }): Promise<MessageReference<Result>> {
    if (currentActor()) {
      throw new ActorCallCycle("actors must use this.sendTo(reference) for transactional delivery")
    }
    const { reference, operation, argumentsValue = {}, options: invocationOptions = {} } = options
    const actor = this.fetchActor(reference.actorType)
    if (!actor.operations.has(operation)) {
      throw new UnknownOperation(`unknown operation ${JSON.stringify(operation)}`)
    }
    const argumentsObject = jsonObject(argumentsValue, { maxBytes: this.settings.maxPayloadBytes })
    await this.authorize({
      kind: "message",
      reference,
      operation,
      argumentsValue: argumentsObject,
      authorizationContext: invocationOptions.authorizationContext,
    })
    return this.enqueue<Result>({
      reference,
      operation,
      deliveryMode: "async",
      argumentsValue: argumentsObject,
      options: invocationOptions,
    })
  }

  async invoke<Result = unknown>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue?: JsonObject
    options?: InvocationOptions
  }): Promise<DeepReadonly<Result>> {
    if (currentActor())
      throw new ActorCallCycle("actors cannot synchronously wait for another actor")
    const { reference, operation, argumentsValue = {}, options: invocationOptions = {} } = options
    const actor = this.fetchActor(reference.actorType)
    const query = this.isQuery(actor.definition, operation)
    const message = actor.operations.has(operation)
    if (!query && !message)
      throw new UnknownOperation(`unknown actor operation ${JSON.stringify(operation)}`)
    const argumentsObject = jsonObject(argumentsValue, { maxBytes: this.settings.maxPayloadBytes })
    await this.authorize({
      kind: query ? "query" : "message",
      reference,
      operation,
      argumentsValue: argumentsObject,
      authorizationContext: invocationOptions.authorizationContext,
    })
    if (this.settings.database.transactionActive?.()) {
      throw new SyncInsideTransaction({
        actorType: reference.actorType,
        actorId: reference.actorId,
        operation,
      })
    }
    const timeout = invocationTimeout(invocationOptions)
    const deadline = performance.now() + timeout
    let messageReference: MessageReference<Result>
    try {
      messageReference = await withDatabaseDeadline({ timeoutMilliseconds: timeout }, () =>
        this.enqueue<Result>({
          reference,
          operation,
          deliveryMode: "sync",
          argumentsValue: argumentsObject,
          options: invocationOptions,
        }),
      )
    } catch (error) {
      if (!(error instanceof DatabaseDeadlineExceeded)) throw error
      this.emitInstrumentation("sync.enqueue_timeout", {
        actorType: reference.actorType,
        actorId: reference.actorId,
        operation,
        timeoutMilliseconds: timeout,
      })
      throw new SyncEnqueueTimeout({
        timeoutMilliseconds: timeout,
        actorType: reference.actorType,
        actorId: reference.actorId,
        operation,
      })
    }
    return this.waitForResult(messageReference, { timeout, deadline })
  }

  async wait<Result>(
    messageReference: MessageReference<Result>,
    options: InvocationOptions = {},
  ): Promise<DeepReadonly<Result>> {
    const timeout = invocationTimeout(options)
    const deadline = performance.now() + timeout
    let message: MessageRow
    try {
      message = await withDatabaseDeadline({ timeoutMilliseconds: timeout }, () =>
        this.authorizeMessageReference(messageReference, options.authorizationContext),
      )
    } catch (error) {
      if (!(error instanceof DatabaseDeadlineExceeded)) throw error
      throw this.databaseContentionTimeout({
        messageReference,
        timeout,
        operation: "unknown",
      })
    }
    if (this.settings.database.transactionActive?.()) {
      throw new SyncInsideTransaction({
        actorType: messageReference.actorType,
        actorId: messageReference.actorId,
        operation: message.operation,
      })
    }
    return this.waitForResult(messageReference, { timeout, deadline })
  }

  private async waitForResult<Result>(
    messageReference: MessageReference<Result>,
    options: { timeout: number; deadline: number },
  ): Promise<DeepReadonly<Result>> {
    this.callerWorker ??= new Worker(this)
    while (performance.now() < options.deadline) {
      let snapshot: { message: MessageRow | undefined; status: MessageStatus }
      try {
        snapshot = await this.messageSnapshotBeforeDeadline(messageReference, options.deadline)
      } catch (error) {
        if (!(error instanceof DatabaseDeadlineExceeded)) throw error
        break
      }
      const { message, status } = snapshot
      if (!message || message.request_id !== messageReference.requestId) {
        throw actorDestroyedWhileWaiting()
      }
      if (message.rejection !== null) throw rejectionFromMessage(message)
      if (status === "completed")
        return readonlyCopy(parseResult(message.result)) as DeepReadonly<Result>
      if (status === "dead") throw messageFailure(message)
      const processed = await this.callerWorker.runOnce({ activationRetention: "release" })
      const remaining = options.deadline - performance.now()
      if (processed === 0 && remaining > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(this.settings.syncPollingIntervalMilliseconds, remaining)),
        )
    }

    let finalSnapshot: { message: MessageRow | undefined; status: MessageStatus }
    try {
      finalSnapshot = await withDatabaseDeadline(
        { timeoutMilliseconds: Math.max(this.settings.syncPollingIntervalMilliseconds, 100) },
        async () => {
          const message = await this.repository.findMessage(messageReference.id)
          return {
            message,
            status: message ? await this.repository.messageStatus(message.id) : "unknown",
          }
        },
      )
    } catch (error) {
      if (!(error instanceof DatabaseDeadlineExceeded)) throw error
      throw this.databaseContentionTimeout({
        messageReference,
        timeout: options.timeout,
        operation: "unknown",
      })
    }
    const { message: finalMessage, status: finalStatus } = finalSnapshot
    if (!finalMessage || finalMessage.request_id !== messageReference.requestId) {
      throw actorDestroyedWhileWaiting()
    }
    if (finalMessage.rejection !== null) throw rejectionFromMessage(finalMessage)
    if (finalStatus === "completed") {
      return readonlyCopy(parseResult(finalMessage.result)) as DeepReadonly<Result>
    }
    if (finalStatus === "dead") {
      throw messageFailure(finalMessage)
    }
    throw await this.syncTimeout(messageReference, options.timeout)
  }

  private messageSnapshotBeforeDeadline(
    messageReference: MessageReference,
    deadline: number,
  ): Promise<{ message: MessageRow | undefined; status: MessageStatus }> {
    const remaining = Math.max(Math.floor(deadline - performance.now()), 0)
    return withDatabaseDeadline({ timeoutMilliseconds: remaining }, async () => {
      const message = await this.repository.findMessage(messageReference.id)
      return {
        message,
        status: message ? await this.repository.messageStatus(message.id) : "unknown",
      }
    })
  }

  private async syncTimeout(
    messageReference: MessageReference,
    timeoutMilliseconds: number,
  ): Promise<SyncTimeout> {
    let diagnostics
    try {
      diagnostics = await withDatabaseDeadline(
        { timeoutMilliseconds: Math.max(this.settings.syncPollingIntervalMilliseconds, 100) },
        () => this.repository.syncDiagnostics(messageReference.id),
      )
    } catch (error) {
      if (!(error instanceof DatabaseDeadlineExceeded)) throw error
      return this.databaseContentionTimeout({
        messageReference,
        timeout: timeoutMilliseconds,
        operation: "unknown",
      })
    }
    if (!diagnostics || diagnostics.message.request_id !== messageReference.requestId) {
      throw actorDestroyedWhileWaiting()
    }
    const { instance, message, process, blocker } = diagnostics
    const activationLive =
      instance.activation_owner_id !== null &&
      instance.activation_expires_at_ms !== null &&
      Number(instance.activation_expires_at_ms) > diagnostics.nowMilliseconds
    const waitingOn =
      Number(instance.paused) !== 0
        ? ("actorPaused" as const)
        : activationLive
          ? ("activationHeld" as const)
          : blocker
            ? ("earlierMessage" as const)
            : diagnostics.status === "claimed"
              ? ("messageClaimed" as const)
              : diagnostics.readyAvailableAtMilliseconds !== undefined &&
                  diagnostics.readyAvailableAtMilliseconds > diagnostics.nowMilliseconds
                ? ("notYetAvailable" as const)
                : diagnostics.status === "ready"
                  ? ("readyUnclaimed" as const)
                  : ("unknown" as const)
    const error = new SyncTimeout({
      details: {
        timeoutMilliseconds,
        actorType: message.actor_type,
        actorId: message.actor_id,
        operation: message.operation,
        messageId: message.id,
        requestId: message.request_id,
        sequence: BigInt(message.sequence),
        status: diagnostics.status,
        waitingOn,
        activation: Object.freeze({
          ownerId: instance.activation_owner_id,
          generation: BigInt(instance.activation_generation),
          expiresAt:
            instance.activation_expires_at_ms === null
              ? null
              : new Date(Number(instance.activation_expires_at_ms)),
          process: process
            ? Object.freeze({
                kind: process.kind,
                heartbeatAt: new Date(Number(process.heartbeat_at_ms)),
                shutdownState: process.shutdown_state,
              })
            : null,
        }),
        blocker: blocker
          ? Object.freeze({
              messageId: blocker.id,
              sequence: BigInt(blocker.sequence),
              operation: blocker.operation,
              status: blocker.membership_status,
            })
          : null,
      },
      messageReference,
    })
    this.emitInstrumentation("sync.timeout", {
      messageId: message.id,
      requestId: message.request_id,
      actorType: message.actor_type,
      actorId: message.actor_id,
      sequence: String(message.sequence),
      status: diagnostics.status,
      waitingOn,
      activationOwnerId: instance.activation_owner_id,
      activationGeneration: String(instance.activation_generation),
    })
    return error
  }

  private databaseContentionTimeout(options: {
    messageReference: MessageReference
    timeout: number
    operation: string
  }): SyncTimeout {
    const { messageReference, timeout, operation } = options
    const error = new SyncTimeout({
      details: {
        timeoutMilliseconds: timeout,
        actorType: messageReference.actorType,
        actorId: messageReference.actorId,
        operation,
        messageId: messageReference.id,
        requestId: messageReference.requestId,
        sequence: messageReference.sequence,
        status: "unknown",
        waitingOn: "databaseContention",
        activation: Object.freeze({
          ownerId: null,
          generation: 0n,
          expiresAt: null,
          process: null,
        }),
        blocker: null,
      },
      messageReference,
    })
    this.emitInstrumentation("sync.timeout", {
      messageId: messageReference.id,
      requestId: messageReference.requestId,
      actorType: messageReference.actorType,
      actorId: messageReference.actorId,
      sequence: String(messageReference.sequence),
      status: "unknown",
      waitingOn: "databaseContention",
      activationOwnerId: null,
      activationGeneration: null,
    })
    return error
  }

  async messageStatus(
    messageReference: MessageReference,
    options: SnapshotOptions = {},
  ): Promise<MessageStatus> {
    const message = await this.authorizeMessageReference(
      messageReference,
      options.authorizationContext,
    )
    return this.repository.messageStatus(message.id)
  }

  async messageResult<Result>(
    messageReference: MessageReference<Result>,
    options: SnapshotOptions = {},
  ): Promise<DeepReadonly<Result> | undefined> {
    const message = await this.authorizeMessageReference(
      messageReference,
      options.authorizationContext,
    )
    if (message.rejection !== null) throw rejectionFromMessage(message)
    if ((await this.repository.messageStatus(message.id)) === "dead") {
      throw messageFailure(message)
    }
    if (message.result === null) return undefined
    return readonlyCopy(parseResult(message.result)) as DeepReadonly<Result>
  }

  async snapshot<ActorType extends Actor>(
    reference: ActorReferenceCore<ActorType>,
    options: SnapshotOptions = {},
  ): Promise<ActorSnapshot<ActorType>> {
    await this.authorize({
      kind: "query",
      reference,
      operation: "__snapshot__",
      argumentsValue: {},
      authorizationContext: options.authorizationContext,
    })
    const registered = this.fetchActor(reference.actorType)
    const instance = await this.repository.findInstanceByIdentity(
      reference.actorType,
      reference.actorId,
    )
    const state = instance
      ? migrateState({
          definition: registered.definition,
          storedVersion: Number(instance.state_version),
          storedState: jsonObject(JSON.parse(instance.state)),
        })
      : initialStateFor(registered.definition)
    return readonlyCopy(state) as ActorSnapshot<ActorType>
  }

  async subscriptionSnapshot(options: {
    actorType: string
    actorId: string
    authorizationContext: unknown
    onAuthorized?: () => void
  }): Promise<BroadcastEvent> {
    const authorized = await this.settings.authorizeSubscription(options)
    if (!authorized) throw new Unauthorized("actor subscription is not authorized")
    options.onAuthorized?.()
    const registered = this.fetchActor(options.actorType)
    const instance = await this.repository.findInstanceByIdentity(
      options.actorType,
      options.actorId,
    )
    const state = instance
      ? migrateState({
          definition: registered.definition,
          storedVersion: Number(instance.state_version),
          storedState: jsonObject(JSON.parse(instance.state)),
        })
      : initialStateFor(registered.definition)
    const actor = hydrateActor({
      definition: registered.definition,
      actorId: options.actorId,
      state,
    })
    return readonlyCopy({
      actorType: options.actorType,
      actorId: options.actorId,
      instanceId: instance?.id ?? "0",
      revision: String(instance?.state_revision ?? 0),
      observables: this.readObservables(actor, registered.definition),
    })
  }

  async subscriptionPayloads(options: {
    actorType: string
    actorId: string
    payloadNames: readonly string[]
    authorizationContext: unknown
  }): Promise<PayloadEnvelope[]> {
    if (options.payloadNames.length === 0) return []
    const registered = this.fetchActor(options.actorType)
    const payloadNames = this.validatePayloadNames(registered, options.payloadNames)
    const snapshot = await this.payloadProjectionSnapshot({
      registered,
      actorType: options.actorType,
      actorId: options.actorId,
    })
    const payloads: PayloadEnvelope[] = []
    for (const name of payloadNames) {
      const payload = await this.projectSubscriptionPayload({
        registered,
        snapshot,
        actorType: options.actorType,
        actorId: options.actorId,
        name,
        authorizationContext: options.authorizationContext,
      })
      if (payload) payloads.push(payload)
    }
    return payloads
  }

  async destroy(
    reference: ActorReferenceCore<Actor>,
    options: DestroyOptions = {},
  ): Promise<boolean> {
    if (currentActor())
      throw new ActorCallCycle("actors cannot synchronously destroy another actor")
    const authorized = await this.settings.authorizeDestroy({
      actorType: reference.actorType,
      actorId: reference.actorId,
      authorizationContext: options.authorizationContext,
    })
    if (!authorized) throw new Unauthorized("actor destruction is not authorized")
    const destroyed = await this.repository.destroy(reference.actorType, reference.actorId)
    if (destroyed) {
      this.emitInstrumentation("actor.destroyed", {
        actorType: reference.actorType,
        actorId: reference.actorId,
      })
    }
    return destroyed
  }

  async inspectDeadLetters(options: AdministrationOptions = {}): Promise<readonly DeadLetter[]> {
    await this.authorizeAdministration({
      action: "inspect",
      resource: "dead_letters",
      authorizationContext: options.authorizationContext,
    })
    const deadLetters = await this.repository.listDeadLetters()
    return Object.freeze(deadLetters.map(deadLetterFromRow))
  }

  async retryDeadLetter(
    id: string,
    options: AdministrationOptions = {},
  ): Promise<MessageReference> {
    await this.authorizeAdministration({
      action: "retry",
      resource: "dead_letters",
      resourceId: id,
      authorizationContext: options.authorizationContext,
    })
    const deadLetter = await this.repository.findDeadLetter(id)
    if (!deadLetter) throw new UnknownDeadLetter(`unknown dead letter ${id}`)
    const actor = this.fetchActor(deadLetter.actor_type)
    if (!actor.operations.has(deadLetter.operation)) {
      throw new UnknownOperation(
        `unknown dead-letter operation ${JSON.stringify(deadLetter.operation)}`,
      )
    }
    const message = await this.repository.retryDeadLetter({
      id,
      initialState: initialStateFor(actor.definition),
      stateVersion: actor.definition.stateVersion,
    })
    this.emitInstrumentation("dead_letter.retried", {
      deadLetterId: id,
      messageId: message.id,
      actorType: message.actor_type,
      actorId: message.actor_id,
      operation: message.operation,
    })
    this.wakeUp("actors")
    return this.messageReferenceFromRow(message)
  }

  async activeInstances(options: ReconciliationPageOptions = {}): Promise<ReconciliationPage> {
    await this.authorizeAdministration({
      action: "active",
      resource: "instances",
      authorizationContext: options.authorizationContext,
    })
    const limit = reconciliationLimit(options.limit)
    const rows = await this.repository.activeInstances({
      limit,
      ...(options.actorType === undefined ? {} : { actorType: options.actorType }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    })
    return reconciliationPage(rows, limit)
  }

  async inspectProcesses(options: AdministrationOptions = {}): Promise<readonly ProcessRecord[]> {
    await this.authorizeAdministration({
      action: "inspect",
      resource: "processes",
      authorizationContext: options.authorizationContext,
    })
    const result = await this.repository.listProcesses()
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          id: row.id,
          kind: row.kind,
          shutdownState: row.shutdown_state,
          stale:
            row.shutdown_state === "running" &&
            Number(row.heartbeat_at_ms) <= result.staleAtMilliseconds,
          startedAt: new Date(Number(row.started_at_ms)),
          heartbeatAt: new Date(Number(row.heartbeat_at_ms)),
          stoppedAt: row.stopped_at_ms === null ? null : new Date(Number(row.stopped_at_ms)),
        }),
      ),
    )
  }

  async cleanupProcesses(options: AdministrationOptions = {}): Promise<ProcessCleanupResult> {
    await this.authorizeAdministration({
      action: "cleanup",
      resource: "processes",
      authorizationContext: options.authorizationContext,
    })
    const cleaned = await this.cleanupStaleProcesses()
    return Object.freeze({ cleaned })
  }

  private async cleanupStaleProcesses(): Promise<number> {
    const cleaned = await this.repository.cleanupStaleProcesses()
    if (cleaned > 0) {
      this.wakeUp("actors")
      this.wakeUp("effects")
      this.wakeUp("reminders")
      this.wakeUp("broadcasts")
      this.emitInstrumentation("processes.cleaned", { count: cleaned })
    }
    return cleaned
  }

  async instancesWithoutPendingWork(
    options: QuietReconciliationOptions,
  ): Promise<ReconciliationPage> {
    await this.authorizeAdministration({
      action: "withoutPendingWork",
      resource: "instances",
      authorizationContext: options.authorizationContext,
    })
    if (!Number.isFinite(options.quietForMilliseconds) || options.quietForMilliseconds < 0) {
      throw new TypeError("quietForMilliseconds must be a non-negative number")
    }
    const limit = reconciliationLimit(options.limit)
    const rows = await this.repository.instancesWithoutPendingWork({
      limit,
      quietForMilliseconds: options.quietForMilliseconds,
      ...(options.actorType === undefined ? {} : { actorType: options.actorType }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    })
    return reconciliationPage(rows, limit)
  }

  async instanceStatesFor(
    options: ReconciliationStatesOptions,
  ): Promise<DeepReadonly<Record<string, JsonObject>>> {
    await this.authorizeAdministration({
      action: "statesFor",
      resource: "instances",
      authorizationContext: options.authorizationContext,
    })
    const actorIds = [...new Set(options.actorIds.map(String))]
    if (actorIds.length > 1_000) {
      throw new TypeError("statesFor accepts at most 1000 actor IDs per batch")
    }
    const actor = this.fetchActor(options.actorType)
    const rows = await this.repository.instanceStatesFor({ actorType: options.actorType, actorIds })
    const states = Object.fromEntries(
      rows.map((row) => [
        row.actor_id,
        migrateState({
          definition: actor.definition,
          storedVersion: Number(row.state_version),
          storedState: jsonObject(JSON.parse(row.state)),
        }),
      ]),
    )
    return readonlyCopy(states)
  }

  async orphanedInstances(options: OrphanedReconciliationOptions): Promise<ReconciliationPage> {
    await this.authorizeAdministration({
      action: "orphaned",
      resource: "instances",
      authorizationContext: options.authorizationContext,
    })
    const limit = reconciliationLimit(options.limit)
    const rows = await this.repository.orphanedInstances({
      actorType: options.actorType,
      ownerIds: [...new Set(options.ownerIds.map(String))],
      limit,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    })
    return reconciliationPage(rows, limit)
  }

  async previewRetention(options: RetentionOptions): Promise<RetentionResult> {
    assertRetentionTarget(options.target)
    await this.authorizeAdministration({
      action: "inspect",
      resource: options.target,
      authorizationContext: options.authorizationContext,
    })
    return Object.freeze({
      target: options.target,
      count: await this.repository.previewRetention(options.target),
    })
  }

  async pruneRetention(options: RetentionOptions): Promise<RetentionResult> {
    assertRetentionTarget(options.target)
    await this.authorizeAdministration({
      action: "prune",
      resource: options.target,
      authorizationContext: options.authorizationContext,
    })
    const result = Object.freeze({
      target: options.target,
      count: await this.repository.pruneRetention(options.target),
    })
    this.emitInstrumentation(`${options.target}.pruned`, { count: result.count })
    return result
  }

  async inspectReminders(options: ReminderPageOptions = {}): Promise<ReminderPage> {
    await this.authorizeAdministration({
      action: "inspect",
      resource: "reminders",
      authorizationContext: options.authorizationContext,
    })
    if (
      options.status !== undefined &&
      options.status !== "scheduled" &&
      options.status !== "paused" &&
      options.status !== "completed"
    ) {
      throw new TypeError(`unknown reminder status ${JSON.stringify(options.status)}`)
    }
    const limit = reminderPageLimit(options.limit)
    const rows = await this.repository.listReminders({
      limit,
      ...(options.actorType === undefined ? {} : { actorType: options.actorType }),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    })
    return reminderPage(rows, limit)
  }

  async resumeReminder(id: string, options: ResumeReminderOptions = {}): Promise<ReminderRecord> {
    await this.authorizeAdministration({
      action: "resume",
      resource: "reminders",
      resourceId: id,
      authorizationContext: options.authorizationContext,
    })
    const runAtMilliseconds = options.runAt?.getTime()
    if (runAtMilliseconds !== undefined && !Number.isFinite(runAtMilliseconds)) {
      throw new TypeError("reminder runAt must be a valid date")
    }
    const result = await this.repository.resumeReminder({
      id,
      ...(runAtMilliseconds === undefined ? {} : { runAtMilliseconds }),
    })
    if (result.resumed) {
      this.emitInstrumentation("reminder.resumed", {
        reminderId: result.reminder.id,
        actorType: result.reminder.actor_type,
        actorId: result.reminder.actor_id,
        operation: result.reminder.operation,
        runAt: new Date(Number(result.reminder.run_at_ms)).toISOString(),
      })
      this.wakeUp("reminders")
    }
    return reminderRecord(result.reminder)
  }

  async executeTurn(
    turn: ClaimedTurn,
    cachedActor?: Actor,
  ): Promise<{ actor: Actor; retainActivation: boolean; activated: boolean }> {
    const startedAt = Date.now()
    this.emitInstrumentation("message.started", messageInstrumentation(turn.message))
    const registered = this.fetchActor(turn.message.actor_type)
    const definition = registered.definition
    const state = migrateState({
      definition,
      storedVersion: Number(turn.instance.state_version),
      storedState: jsonObject(JSON.parse(turn.instance.state)),
    })
    const actor =
      cachedActor ??
      hydrateActor({
        definition,
        actorId: turn.message.actor_id,
        state: deepCopy(state),
      })
    let activated = cachedActor !== undefined
    const messageContext = actorMessageContext(turn.message)
    const renewalController = new AbortController()
    let renewalError: unknown
    const renewal = this.renewLease(turn, renewalController.signal).catch((error: unknown) => {
      renewalError = error
    })
    let stateBefore: JsonObject | undefined

    try {
      if (!activated) {
        await withActorContext({ actor, runtime: this }, () => actor.activate())
        activated = true
        this.emitInstrumentation("activation.started", {
          actorType: turn.message.actor_type,
          actorId: turn.message.actor_id,
          instanceId: turn.instance.id,
          generation: String(turn.activationGeneration),
        })
      }
      const oldObservables = this.readObservables(actor, definition)
      stateBefore = deepCopy(actorState(actor, definition.stateKeys))
      const before = stableJson(stateBefore)
      const query = this.isQuery(definition, turn.message.operation)
      const argumentsValue = jsonObject(JSON.parse(turn.message.arguments))
      const rawResult = await withActorContext(
        { actor, runtime: this, message: messageContext },
        async () => {
          if (definition.stateKeys.includes(turn.message.operation)) {
            return (actor as unknown as Record<string, unknown>)[turn.message.operation]
          }
          return actor.invoke(turn.message.operation, argumentsValue)
        },
      )
      if (query && stableJson(actorState(actor, definition.stateKeys)) !== before) {
        throw new QueryMutatedState(`query ${turn.message.operation} mutated actor state`)
      }
      if (query && actor.hasIntents()) {
        throw new QueryMutatedState(`query ${turn.message.operation} staged durable work`)
      }
      const result = normalizeJson(rawResult === undefined ? null : rawResult, {
        maxBytes: this.settings.maxResultBytes,
      })
      const committedState = jsonObject(actorState(actor, definition.stateKeys), {
        maxBytes: this.settings.maxStateBytes,
      })
      const observables = this.readObservables(actor, definition)
      const changedObservables = Object.fromEntries(
        Object.entries(observables).filter(
          ([name, value]) => stableJson(value) !== stableJson(oldObservables[name]),
        ),
      )
      const broadcastObservables =
        Object.keys(changedObservables).length > 0 ||
        (Object.keys(definition.payloads).length > 0 && stableJson(committedState) !== before)
          ? changedObservables
          : undefined
      renewalController.abort()
      await renewal
      if (renewalError) throw renewalError
      const intents = actor.drainIntents()
      const completion = await this.repository.complete(turn, {
        state: committedState,
        stateVersion: definition.stateVersion,
        result,
        ...(broadcastObservables === undefined ? {} : { broadcastObservables }),
        intents,
        executeCommitAction: async (intent, connection) => {
          const handler = this.commitActions.get(intent.name)
          if (!handler)
            throw new UnknownCommitAction(`unknown commit action ${JSON.stringify(intent.name)}`)
          const attributes = {
            commitAction: intent.name,
            ...messageInstrumentation(turn.message),
          }
          this.emitInstrumentation("commit_action.started", attributes)
          try {
            await handler(intent.arguments, {
              actorType: turn.message.actor_type,
              actorId: turn.message.actor_id,
              messageId: turn.message.id,
              requestId: turn.message.request_id,
              sequence: BigInt(turn.message.sequence),
              connection,
            })
            this.emitInstrumentation("commit_action.completed", attributes)
          } catch (error) {
            this.emitInstrumentation("commit_action.failed", {
              ...attributes,
              errorName: error instanceof Error ? error.name : "Error",
            })
            throw error
          }
        },
      })
      if (intents.outboundMessages.length > 0) this.wakeUp("actors")
      if (intents.effects.length > 0) this.wakeUp("effects")
      if (intents.reminders.length > 0) this.wakeUp("reminders")
      if (broadcastObservables !== undefined) this.wakeUp("broadcasts")
      for (const replacement of completion.reminderReplacements) {
        this.emitInstrumentation("reminder.replaced", {
          reminderId: replacement.reminderId,
          actorType: turn.message.actor_type,
          actorId: turn.message.actor_id,
          operation: replacement.operation,
          previousRunAt: new Date(replacement.previousRunAtMilliseconds).toISOString(),
          nextRunAt: new Date(replacement.nextRunAtMilliseconds).toISOString(),
        })
      }
      this.emitInstrumentation("message.completed", {
        ...messageInstrumentation(turn.message),
        durationMilliseconds: Date.now() - startedAt,
      })
      return { actor, retainActivation: true, activated }
    } catch (error) {
      renewalController.abort()
      await renewal
      actor.discardIntents()
      if (stateBefore) restoreActorState({ actor, definition, state: stateBefore })
      if (error instanceof LostActivation) {
        this.emitInstrumentation("activation.lost", {
          ...messageInstrumentation(turn.message),
          durationMilliseconds: Date.now() - startedAt,
        })
        return { actor, retainActivation: false, activated }
      }
      if (error instanceof Rejected) {
        await this.repository.reject(turn, {
          code: error.code,
          message: error.message,
          details: error.details,
        })
        this.emitInstrumentation("message.rejected", {
          ...messageInstrumentation(turn.message),
          code: error.code,
          durationMilliseconds: Date.now() - startedAt,
        })
        return { actor, retainActivation: activated, activated }
      }
      const retryable = !(error instanceof NonRetryableError)
      const outcome = await this.repository.fail(turn, {
        error,
        retryable,
      })
      this.emitInstrumentation("message.failed", {
        ...messageInstrumentation(turn.message),
        retryable,
        errorName: error instanceof Error ? error.name : "Error",
        durationMilliseconds: Date.now() - startedAt,
        outcome,
      })
      if (outcome === "dead") {
        this.emitInstrumentation("dead_letter.created", messageInstrumentation(turn.message))
      }
      return { actor, retainActivation: activated, activated }
    }
  }

  async deactivateActor(options: {
    turn: ClaimedTurn
    actor?: Actor
    lifecycle: "activated" | "unactivated"
  }): Promise<void> {
    const { turn, actor } = options
    try {
      if (actor && options.lifecycle === "activated") {
        await withActorContext({ actor, runtime: this }, () => actor.deactivate())
      }
    } catch (error) {
      this.emitInstrumentation("activation.deactivation_failed", {
        actorType: turn.message.actor_type,
        actorId: turn.message.actor_id,
        instanceId: turn.instance.id,
        generation: String(turn.activationGeneration),
        errorName: error instanceof Error ? error.name : "Error",
      })
      this.settings.logger.error({
        event: "solid_objects.activation.deactivation_failed",
        actorType: turn.message.actor_type,
        actorId: turn.message.actor_id,
        errorName: error instanceof Error ? error.name : "Error",
      })
    } finally {
      actor?.discardIntents()
      await this.repository.releaseActivation({
        instanceId: turn.instance.id,
        processId: turn.processId,
        activationToken: turn.activationToken,
        activationGeneration: turn.activationGeneration,
      })
    }
  }

  async close(): Promise<void> {
    if (this.running)
      throw new Error("abort runtime.run() and wait for it before closing the runtime")
    await this.callerWorker?.stop()
    this.realtime.close()
    await this.settings.wakeUp.close()
    await this.settings.database.close()
    clearDefaultRuntime(this)
  }

  async resetForTesting(): Promise<void> {
    if (this.running) throw new Error("abort runtime.run() before resetting test state")
    await this.callerWorker?.stop()
    this.callerWorker = undefined
    this.realtime.close()
    await this.repository.resetForTesting()
  }

  emitInstrumentation(name: string, attributes: JsonObject): void {
    const instrumentation = this.settings.instrumentation
    if (!instrumentation) return
    try {
      instrumentation(
        Object.freeze({
          name: `solid_objects.${name}`,
          occurredAt: new Date().toISOString(),
          attributes: readonlyCopy(attributes),
        }),
      )
    } catch (error) {
      this.settings.logger.error({
        event: "solid_objects.instrumentation.failed",
        instrumentationEvent: `solid_objects.${name}`,
        errorName: error instanceof Error ? error.name : "Error",
      })
    }
  }

  async executeEffect(effect: EffectRow): Promise<void> {
    try {
      const handler = this.effects.get(effect.name)
      if (!handler) throw new UnknownEffect(`unknown effect ${JSON.stringify(effect.name)}`)
      const result = normalizeJson(
        (await handler(jsonObject(JSON.parse(effect.arguments)), {
          id: effect.id,
          attempt: Number(effect.attempt_count),
          actorType: effect.actor_type,
          actorId: effect.actor_id,
          messageId: effect.message_id,
        })) ?? null,
        { maxBytes: this.settings.maxResultBytes },
      )
      await this.repository.completeEffect(effect, result)
      if (effect.success_operation) this.wakeUp("actors")
      this.emitInstrumentation("effect.completed", effectInstrumentation(effect))
    } catch (error) {
      await this.repository.failEffect({
        effect,
        error,
        retryable: !(error instanceof NonRetryableError),
      })
      const exhausted =
        error instanceof NonRetryableError ||
        Number(effect.attempt_count) >= Number(effect.max_attempts)
      if (exhausted && effect.failure_operation) this.wakeUp("actors")
      this.emitInstrumentation("effect.failed", {
        ...effectInstrumentation(effect),
        errorName: error instanceof Error ? error.name : "Error",
      })
    }
  }

  async executeReminder(reminder: ReminderRow): Promise<void> {
    const actor = this.fetchActor(reminder.actor_type)
    if (!actor.operations.has(reminder.operation)) {
      throw new UnknownOperation(`unknown reminder operation ${JSON.stringify(reminder.operation)}`)
    }
    await this.repository.enqueueReminder(reminder)
    this.wakeUp("actors")
    this.emitInstrumentation("reminder.enqueued", {
      reminderId: reminder.id,
      actorType: reminder.actor_type,
      actorId: reminder.actor_id,
      operation: reminder.operation,
      occurrence: Number(reminder.occurrence),
    })
  }

  async executeBroadcast(broadcast: BroadcastRow): Promise<void> {
    const deliver = this.settings.broadcast
    try {
      const event = readonlyCopy({
        actorType: broadcast.actor_type,
        actorId: broadcast.actor_id,
        instanceId: broadcast.instance_id,
        revision: String(broadcast.state_revision),
        observables: jsonObject(JSON.parse(broadcast.observables)),
      })
      await this.realtime.publish(event)
      await deliver?.(event)
      await this.repository.completeBroadcast(broadcast)
      this.emitInstrumentation("broadcast.delivered", broadcastInstrumentation(broadcast))
    } catch (error) {
      await this.repository.failBroadcast(broadcast, error)
      this.emitInstrumentation("broadcast.failed", {
        ...broadcastInstrumentation(broadcast),
        errorName: error instanceof Error ? error.name : "Error",
      })
    }
  }

  private async enqueue<Result>(options: {
    reference: ActorReferenceCore<Actor>
    operation: string
    deliveryMode: "async" | "sync" | "internal"
    argumentsValue: JsonObject
    options: AsyncInvocationOptions | InvocationOptions
  }): Promise<MessageReference<Result>> {
    const {
      reference,
      operation,
      deliveryMode,
      argumentsValue,
      options: invocationOptions,
    } = options
    const registered = this.fetchActor(reference.actorType)
    const message = await this.repository.enqueue({
      actorType: reference.actorType,
      actorId: reference.actorId,
      operation,
      deliveryMode,
      arguments: argumentsValue,
      initialState: initialStateFor(registered.definition),
      stateVersion: registered.definition.stateVersion,
      ...(invocationOptions.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: invocationOptions.idempotencyKey }),
      ...("availableAt" in invocationOptions && invocationOptions.availableAt !== undefined
        ? { availableAtMilliseconds: invocationOptions.availableAt.getTime() }
        : {}),
    })
    this.emitInstrumentation("message.enqueued", messageInstrumentation(message))
    this.wakeUp("actors")
    return this.messageReferenceFromRow<Result>(message)
  }

  private messageReferenceFromRow<Result = unknown>(message: MessageRow): MessageReference<Result> {
    return new MessageReference<Result>({
      runtime: this,
      id: message.id,
      requestId: message.request_id,
      actorType: message.actor_type,
      actorId: message.actor_id,
      sequence: BigInt(message.sequence),
      operation: message.operation,
      databaseTransactionActive: () => this.settings.database.transactionActive?.() ?? false,
    })
  }

  private async renewLease(turn: ClaimedTurn, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await waitFor(this.settings.leaseRenewalIntervalMilliseconds, signal)
      if (signal.aborted) return
      await this.repository.renewTurn(turn)
    }
  }

  private async buildComponentSlots(): Promise<ComponentSlot[]> {
    const factories: Array<() => LongRunningComponent> = [
      ...Array.from({ length: this.settings.workerCount }, () => () => this.worker()),
      ...Array.from({ length: this.settings.effectWorkerCount }, () => () => this.effectWorker()),
      ...Array.from(
        { length: this.settings.reminderSchedulerCount },
        () => () => this.reminderScheduler(),
      ),
      ...(broadcastsEnabled(this.settings)
        ? Array.from(
            { length: this.settings.broadcastWorkerCount },
            () => () => this.broadcastWorker(),
          )
        : []),
      ...(this.settings.retentionIntervalMilliseconds > 0
        ? [
            () =>
              new MaintenanceScheduler({
                runtime: this,
                intervalMilliseconds: this.settings.retentionIntervalMilliseconds,
                failureEvent: "supervisor.retention_failed",
                operation: () => this.pruneExpiredRecords(),
              }),
          ]
        : []),
      ...(this.settings.deadProcessCleanupIntervalMilliseconds > 0
        ? [
            () =>
              new MaintenanceScheduler({
                runtime: this,
                intervalMilliseconds: this.settings.deadProcessCleanupIntervalMilliseconds,
                failureEvent: "supervisor.process_cleanup_failed",
                operation: () => this.cleanupStaleProcesses().then(() => undefined),
              }),
          ]
        : []),
    ]

    for (const { count, factory } of this.additionalComponents) {
      for (let index = 0; index < count; index += 1) factories.push(factory)
    }

    const slots: ComponentSlot[] = []

    try {
      for (const factory of factories) {
        const component = factory()
        slots.push({ factory, component, cleanupAttempted: false })
        validateComponent(component)
      }
      return slots
    } catch (error) {
      await Promise.allSettled(slots.map(({ component }) => this.stopComponent(component)))
      throw error
    }
  }

  private async pruneExpiredRecords(): Promise<void> {
    for (const target of ["messages", "processes"] as const) {
      const count = await this.repository.pruneRetention(target)
      this.emitInstrumentation(`${target}.pruned`, { count })
    }
  }

  private async supervise(options: {
    slot: ComponentSlot
    signal: AbortSignal
    shutdownDeadline: () => number | undefined
  }): Promise<void> {
    const { slot, signal, shutdownDeadline } = options
    let failureCount = 0
    let replacementErrorName: string | null = null

    while (!signal.aborted) {
      const component = slot.component
      const requestShutdown = () => {
        try {
          component.requestShutdown()
        } catch (error) {
          this.emitInstrumentation("supervisor.component_cleanup_failed", {
            role: component.constructor.name,
            errorName: error instanceof Error ? error.name : "Error",
          })
        }
      }
      signal.addEventListener("abort", requestShutdown, { once: true })
      const outcome = await this.waitForComponent({ component, signal, shutdownDeadline })
      signal.removeEventListener("abort", requestShutdown)
      if (outcome.status === "timeout") {
        this.emitInstrumentation("supervisor.component_shutdown_timeout", {
          role: component.constructor.name,
          phase: "run",
          timeoutMilliseconds: this.settings.shutdownTimeoutMilliseconds,
        })
        return
      }
      await this.stopComponent(component, {
        shutdown: { signal, deadline: shutdownDeadline },
      })
      slot.cleanupAttempted = true
      if (outcome.status === "fulfilled") {
        replacementErrorName = null
      } else {
        replacementErrorName = outcome.error instanceof Error ? outcome.error.name : "Error"
      }
      if (signal.aborted) return

      while (!signal.aborted) {
        failureCount += 1
        await waitFor(this.supervisorRestartDelay(failureCount), signal)
        if (signal.aborted) return

        let replacement: LongRunningComponent | undefined
        try {
          replacement = slot.factory()
          validateComponent(replacement)
          slot.component = replacement
          slot.cleanupAttempted = false
          this.emitInstrumentation("supervisor.role_replaced", {
            role: component.constructor.name,
            errorName: replacementErrorName,
            failureCount,
          })
          break
        } catch (error) {
          if (replacement) await this.stopComponent(replacement)
          replacementErrorName = error instanceof Error ? error.name : "Error"
          this.emitInstrumentation("supervisor.role_replacement_failed", {
            role: component.constructor.name,
            errorName: replacementErrorName,
            failureCount,
          })
        }
      }
    }
  }

  private waitForComponent(options: {
    component: LongRunningComponent
    signal: AbortSignal
    shutdownDeadline: () => number | undefined
  }): Promise<ComponentRunOutcome> {
    const { component, signal, shutdownDeadline } = options
    return new Promise((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: ComponentRunOutcome) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        signal.removeEventListener("abort", beginShutdown)
        resolve(outcome)
      }
      const beginShutdown = () => {
        const deadline = shutdownDeadline()
        if (deadline === undefined) return
        timeout = setTimeout(
          () => finish({ status: "timeout" }),
          Math.max(deadline - performance.now(), 0),
        )
      }
      signal.addEventListener("abort", beginShutdown, { once: true })
      if (signal.aborted) beginShutdown()
      void Promise.resolve()
        .then(() => component.run(signal))
        .then(
          () => finish({ status: "fulfilled" }),
          (error: unknown) => finish({ status: "rejected", error }),
        )
    })
  }

  private async stopComponent(
    component: LongRunningComponent,
    options: {
      shutdown?: { signal: AbortSignal; deadline: () => number | undefined }
    } = {},
  ): Promise<void> {
    try {
      component.requestShutdown()
    } catch (error) {
      this.reportComponentCleanupFailure(component, error)
    }
    try {
      const stopping = Promise.resolve().then(() => component.stop())
      if (options.shutdown === undefined) {
        await stopping
        return
      }
      const stopped = await promiseBeforeShutdownDeadline(stopping, options.shutdown)
      if (stopped) return
      this.emitInstrumentation("supervisor.component_shutdown_timeout", {
        role: component.constructor.name,
        phase: "stop",
        timeoutMilliseconds: this.settings.shutdownTimeoutMilliseconds,
      })
    } catch (error) {
      this.reportComponentCleanupFailure(component, error)
    }
  }

  private reportComponentCleanupFailure(component: LongRunningComponent, error: unknown): void {
    this.emitInstrumentation("supervisor.component_cleanup_failed", {
      role: component.constructor.name,
      errorName: error instanceof Error ? error.name : "Error",
    })
  }

  private supervisorRestartDelay(failureCount: number): number {
    const exponent = Math.min(failureCount - 1, 16)
    return Math.min(
      this.settings.supervisorRestartDelayMilliseconds * 2 ** exponent,
      this.settings.supervisorMaximumRestartDelayMilliseconds,
    )
  }

  private readObservables(actor: Actor, definition: ValidatedActorDefinition): JsonObject {
    const stateBefore = stableJson(actorState(actor, definition.stateKeys))
    const intentCount = actor.intentCount()
    const values = withActorProjection({ actor, runtime: this }, () => actor.observableValues())
    if (
      stableJson(actorState(actor, definition.stateKeys)) !== stateBefore ||
      actor.intentCount() !== intentCount
    ) {
      throw new QueryMutatedState("observables must not mutate actor state or stage durable work")
    }
    return values
  }

  private validatePayloadNames(
    registered: RegisteredActor,
    requestedNames: readonly string[],
  ): string[] {
    const names = [...new Set(requestedNames)]
    for (const name of names) {
      if (registered.definition.payloads[name]) continue
      throw new UnknownPayloadBroadcast(`unknown payload broadcast ${JSON.stringify(name)}`)
    }
    return names
  }

  private async payloadProjectionSnapshot(options: {
    registered: RegisteredActor
    actorType: string
    actorId: string
  }): Promise<PayloadProjectionSnapshot> {
    const instance = await this.repository.findInstanceByIdentity(
      options.actorType,
      options.actorId,
    )
    if (!instance) {
      return {
        state: initialStateFor(options.registered.definition),
        instanceId: "0",
        revision: "0",
      }
    }
    return {
      state: migrateState({
        definition: options.registered.definition,
        storedVersion: Number(instance.state_version),
        storedState: jsonObject(JSON.parse(instance.state)),
      }),
      instanceId: instance.id,
      revision: String(instance.state_revision),
    }
  }

  private async projectSubscriptionPayload(options: {
    registered: RegisteredActor
    snapshot: PayloadProjectionSnapshot
    actorType: string
    actorId: string
    name: string
    authorizationContext: unknown
  }): Promise<PayloadEnvelope | undefined> {
    try {
      const authorized = await this.settings.authorizeQuery({
        actorType: options.actorType,
        actorId: options.actorId,
        operation: options.name,
        arguments: {},
        authorizationContext: options.authorizationContext,
      })
      if (!authorized) return undefined

      const actor = hydrateActor({
        definition: options.registered.definition,
        actorId: options.actorId,
        state: deepCopy(options.snapshot.state),
      })
      const stateBefore = stableJson(actorState(actor, options.registered.definition.stateKeys))
      const intentCount = actor.intentCount()
      const handler = options.registered.definition.payloads[options.name]
      if (!handler) {
        throw new UnknownPayloadBroadcast(`unknown payload broadcast ${options.name}`)
      }
      const rawPayload = await withActorProjection({ actor, runtime: this }, () =>
        handler(actor, options.authorizationContext),
      )
      if (
        stableJson(actorState(actor, options.registered.definition.stateKeys)) !== stateBefore ||
        actor.intentCount() !== intentCount
      ) {
        throw new QueryMutatedState("payload broadcasts must not mutate actor state or stage work")
      }
      const payload = normalizeJson(rawPayload, { maxBytes: this.settings.maxPayloadBytes })
      if (!Array.isArray(payload) && (typeof payload !== "object" || payload === null)) {
        throw new InvalidPayloadBroadcast(
          `payload broadcast ${JSON.stringify(options.name)} must return a JSON object or array`,
        )
      }
      return readonlyCopy({
        version: 1,
        kind: "payload",
        actorType: options.actorType,
        actorId: options.actorId,
        instanceId: options.snapshot.instanceId,
        revision: options.snapshot.revision,
        name: options.name,
        payload,
      })
    } catch (error) {
      this.emitInstrumentation("payload_broadcast.failed", {
        actorType: options.actorType,
        actorId: options.actorId,
        payload: options.name,
        errorName: error instanceof Error ? error.name : "Error",
      })
      return undefined
    }
  }

  private fetchActor(actorType: string): RegisteredActor {
    const actor = this.registry.get(actorType)
    if (!actor) throw new UnknownActorType(`unknown actor type ${actorType}`)
    return actor
  }

  private isQuery(definition: ValidatedActorDefinition, name: string): boolean {
    return definition.queries.includes(name)
  }

  private wakeUp(role: WakeUpRole): void {
    try {
      Promise.resolve(this.settings.wakeUp.notify(role)).catch((error: unknown) => {
        this.logWakeUpFailure(role, error)
      })
    } catch (error) {
      this.logWakeUpFailure(role, error)
    }
  }

  private logWakeUpFailure(role: WakeUpRole, error: unknown): void {
    this.settings.logger.error({
      event: "solid_objects.wake_up.failed",
      role,
      errorName: error instanceof Error ? error.name : "Error",
    })
  }

  private async authorize(options: {
    kind: "message" | "query"
    reference: ActorReferenceCore<Actor>
    operation: string
    argumentsValue: JsonObject
    authorizationContext: unknown
  }): Promise<void> {
    const { kind, reference, operation, argumentsValue, authorizationContext } = options
    const policy = kind === "query" ? this.settings.authorizeQuery : this.settings.authorizeMessage
    const authorized = await policy({
      actorType: reference.actorType,
      actorId: reference.actorId,
      operation,
      arguments: argumentsValue,
      authorizationContext,
    })
    if (!authorized) throw new Unauthorized(`actor ${kind} is not authorized`)
  }

  private async authorizeAdministration(options: {
    action: string
    resource: string
    resourceId?: string
    authorizationContext: unknown
  }): Promise<void> {
    const authorized = await this.settings.authorizeAdministration(options)
    if (!authorized) throw new Unauthorized("actor administration is not authorized")
  }

  private async authorizeMessageReference(
    messageReference: MessageReference,
    authorizationContext: unknown,
  ): Promise<ClaimedTurn["message"]> {
    const message = await this.repository.findMessage(messageReference.id)
    if (!message || message.request_id !== messageReference.requestId) {
      throw new Unauthorized("message result is not authorized")
    }
    const registered = this.fetchActor(message.actor_type)
    const reference = new ActorReferenceCore({
      runtime: this,
      actorClass: registered.actorClass,
      actorType: message.actor_type,
      actorId: message.actor_id,
      operations: registered.operations,
      queries: registered.queries,
    })
    const query = this.isQuery(registered.definition, message.operation)
    await this.authorize({
      kind: query ? "query" : "message",
      reference,
      operation: message.operation,
      argumentsValue: jsonObject(JSON.parse(message.arguments)),
      authorizationContext,
    })
    return message
  }
}

export function createRuntime(configuration: SolidObjectsConfiguration): SolidObjectsRuntime {
  return new SolidObjectsRuntime(configuration)
}

export function configure(configuration: SolidObjectsConfiguration): SolidObjectsRuntime {
  const runtime = createRuntime(configuration)
  setDefaultRuntime(runtime)
  return runtime
}

function parseResult(value: string | null): JsonValue {
  if (value === null) return null
  return normalizeJson(JSON.parse(value))
}

function invocationTimeout(options: InvocationOptions): number {
  const timeout = options.timeoutMilliseconds ?? 5_000
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError("timeoutMilliseconds must be a non-negative number")
  }
  return timeout
}

function rejectionFromMessage(message: ClaimedTurn["message"]): Rejected {
  const rejection = JSON.parse(message.rejection ?? "{}") as {
    code: string
    message: string
    details: Record<string, unknown>
  }
  const error = new Rejected(rejection)
  error.messageId = message.id
  return error
}

function messageFailure(message: MessageRow): MessageFailed {
  const details = jsonObject(JSON.parse(message.error ?? "{}"))
  return new MessageFailed({ messageId: message.id, details })
}

function actorDestroyedWhileWaiting(): ActorDestroyed {
  return new ActorDestroyed("actor was destroyed while waiting for its result")
}

function messageInstrumentation(message: MessageRow): JsonObject {
  return {
    messageId: message.id,
    requestId: message.request_id,
    actorType: message.actor_type,
    actorId: message.actor_id,
    sequence: String(message.sequence),
    operation: message.operation,
    deliveryMode: message.delivery_mode,
    attempt: Number(message.attempt_count),
  }
}

function actorMessageContext(message: MessageRow): MessageContext {
  return Object.freeze({
    id: message.id,
    requestId: message.request_id,
    idempotencyKey: message.idempotency_key,
    enqueuedAt: new Date(Number(message.created_at_ms)),
    actorType: message.actor_type,
    actorId: message.actor_id,
    sequence: BigInt(message.sequence),
    attempt: Number(message.attempt_count),
  })
}

function restoreActorState(options: {
  actor: Actor
  definition: ValidatedActorDefinition
  state: JsonObject
}): void {
  const target = options.actor as unknown as Record<string, unknown>
  for (const key of options.definition.stateKeys) target[key] = deepCopy(options.state[key])
}

function effectInstrumentation(effect: EffectRow): JsonObject {
  return {
    effectId: effect.id,
    effectName: effect.name,
    messageId: effect.message_id,
    actorType: effect.actor_type,
    actorId: effect.actor_id,
    attempt: Number(effect.attempt_count),
  }
}

function broadcastInstrumentation(broadcast: BroadcastRow): JsonObject {
  return {
    broadcastId: broadcast.id,
    messageId: broadcast.message_id,
    actorType: broadcast.actor_type,
    actorId: broadcast.actor_id,
    revision: String(broadcast.state_revision),
    attempt: Number(broadcast.attempt_count),
  }
}

function reminderPageLimit(value: number | undefined): number {
  const limit = value ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("reminder limit must be an integer between 1 and 1000")
  }
  return limit
}

function reminderPage(rows: ReminderRow[], limit: number): ReminderPage {
  const pageRows = rows.slice(0, limit)
  const items = Object.freeze(pageRows.map(reminderRecord))
  const last = pageRows.at(-1)
  return Object.freeze({
    items,
    nextCursor: rows.length > limit && last ? last.id : null,
  })
}

function reminderRecord(row: ReminderRow): ReminderRecord {
  const parsedError = row.error === null ? null : jsonObject(JSON.parse(row.error))
  return Object.freeze({
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    operation: row.operation,
    runAt: new Date(Number(row.run_at_ms)),
    intervalMilliseconds: row.interval_ms === null ? null : Number(row.interval_ms),
    missedPolicy: row.missed_policy,
    occurrence: Number(row.occurrence),
    status: row.status,
    errorName: typeof parsedError?.name === "string" ? parsedError.name : null,
  })
}

function deadLetterFromRow(row: DeadLetterRow): DeadLetter {
  return Object.freeze({
    id: row.id,
    messageId: row.message_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    operation: row.operation,
    deliveryMode: row.delivery_mode,
    arguments: readonlyCopy(jsonObject(JSON.parse(row.arguments))),
    attempts: Number(row.attempts),
    error: readonlyCopy(jsonObject(JSON.parse(row.error))),
    createdAt: new Date(Number(row.created_at_ms)),
    retriedMessageId: row.retried_message_id,
  })
}

function reconciliationLimit(value: number | undefined): number {
  const limit = value ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("reconciliation limit must be an integer between 1 and 1000")
  }
  return limit
}

function reconciliationPage(rows: InstanceRow[], limit: number): ReconciliationPage {
  const pageRows = rows.slice(0, limit)
  const items = Object.freeze(pageRows.map(reconciliationInstanceFromRow))
  const last = pageRows.at(-1)
  return Object.freeze({
    items,
    nextCursor: rows.length > limit && last ? last.id : null,
  })
}

function reconciliationInstanceFromRow(row: InstanceRow): ReconciliationInstance {
  return Object.freeze({
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    stateVersion: Number(row.state_version),
    revision: String(row.state_revision),
    status: Number(row.paused) === 0 ? "active" : "paused",
    createdAt: new Date(Number(row.created_at_ms)),
    updatedAt: new Date(Number(row.updated_at_ms)),
  })
}

function assertRetentionTarget(value: string): void {
  if (value === "messages" || value === "instances" || value === "processes") return
  throw new TypeError(`unknown retention target ${JSON.stringify(value)}`)
}

async function promiseBeforeShutdownDeadline(
  promise: Promise<unknown>,
  shutdown: { signal: AbortSignal; deadline: () => number | undefined },
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      shutdown.signal.removeEventListener("abort", beginShutdown)
      resolve(result)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      shutdown.signal.removeEventListener("abort", beginShutdown)
      reject(error)
    }
    const beginShutdown = () => {
      const deadline = shutdown.deadline()
      if (deadline === undefined) return
      timeout = setTimeout(() => finish(false), Math.max(deadline - performance.now(), 0))
    }
    shutdown.signal.addEventListener("abort", beginShutdown, { once: true })
    if (shutdown.signal.aborted) beginShutdown()
    void promise.then(() => finish(true), fail)
  })
}

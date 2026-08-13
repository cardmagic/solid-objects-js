import type { Actor, ActorClass } from "./actor.js"
import { BroadcastWorker } from "./broadcast-worker.js"
import {
  buildSettings,
  validateComponent,
  type ComponentRegistration,
  type SolidObjectsConfiguration,
} from "./configuration.js"
import { currentActor, withActorContext } from "./context.js"
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
  InvalidActor,
  LostActivation,
  NonRetryableError,
  QueryMutatedState,
  Rejected,
  SyncTimeout,
  Unauthorized,
  UnknownCommitAction,
  UnknownDeadLetter,
  UnknownEffect,
  UnknownActorType,
  UnknownOperation,
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
  MessageStatus,
  SnapshotOptions,
} from "./types.js"
import { SolidObjectsTestHelper } from "./test-helper.js"
import { waitFor, Worker } from "./worker.js"
import { EffectWorker } from "./effect-worker.js"

interface RegisteredActor {
  actorClass: ActorClass
  definition: ValidatedActorDefinition
  operations: ReadonlySet<string>
  queries: ReadonlySet<string>
}

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
    if (!this.settings.broadcast) throw new TypeError("broadcast is not configured")
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
      broadcastWorkerCount: this.settings.broadcast ? this.settings.broadcastWorkerCount : 0,
    })
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    let components: LongRunningComponent[] = []

    try {
      components = await this.buildComponents()
      await Promise.all(components.map((component) => component.run(controller.signal)))
    } finally {
      controller.abort()
      for (const component of components) component.requestShutdown()
      await Promise.allSettled(components.map((component) => component.stop()))
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
    const messageReference = await this.enqueue<Result>({
      reference,
      operation,
      deliveryMode: "sync",
      argumentsValue: argumentsObject,
      options: invocationOptions,
    })
    return this.waitForResult(messageReference, invocationOptions)
  }

  async wait<Result>(
    messageReference: MessageReference<Result>,
    options: InvocationOptions = {},
  ): Promise<DeepReadonly<Result>> {
    await this.authorizeMessageReference(messageReference, options.authorizationContext)
    return this.waitForResult(messageReference, options)
  }

  private async waitForResult<Result>(
    messageReference: MessageReference<Result>,
    options: InvocationOptions,
  ): Promise<DeepReadonly<Result>> {
    const timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000
    const deadline = Date.now() + timeoutMilliseconds
    this.callerWorker ??= new Worker(this)
    while (Date.now() <= deadline) {
      const message = await this.repository.findMessage(messageReference.id)
      if (!message || message.request_id !== messageReference.requestId) {
        throw new Error("message reference no longer identifies this invocation")
      }
      if (message.rejection !== null) throw rejectionFromMessage(message)
      const status = await this.repository.messageStatus(message.id)
      if (status === "completed")
        return readonlyCopy(parseResult(message.result)) as DeepReadonly<Result>
      if (status === "dead")
        throw new Error(JSON.parse(message.error ?? "{}")?.message ?? "actor message failed")
      const processed = await this.callerWorker.runOnce()
      if (processed === 0)
        await new Promise((resolve) =>
          setTimeout(resolve, this.settings.syncPollingIntervalMilliseconds),
        )
    }

    throw new SyncTimeout({
      timeoutMilliseconds,
      actorType: messageReference.actorType,
      actorId: messageReference.actorId,
      operation: (await this.repository.findMessage(messageReference.id))?.operation ?? "unknown",
      messageId: messageReference.id,
      requestId: messageReference.requestId,
      sequence: messageReference.sequence,
      status: await this.repository.messageStatus(messageReference.id),
    })
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
      throw new Error(JSON.parse(message.error ?? "{}")?.message ?? "actor message failed")
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
    }
    return reminderRecord(result.reminder)
  }

  async executeTurn(turn: ClaimedTurn): Promise<void> {
    const startedAt = Date.now()
    this.emitInstrumentation("message.started", messageInstrumentation(turn.message))
    const registered = this.fetchActor(turn.message.actor_type)
    const definition = registered.definition
    const state = migrateState({
      definition,
      storedVersion: Number(turn.instance.state_version),
      storedState: jsonObject(JSON.parse(turn.instance.state)),
    })
    const actor = hydrateActor({
      definition,
      actorId: turn.message.actor_id,
      state: deepCopy(state),
    })
    const messageContext = {
      id: turn.message.id,
      requestId: turn.message.request_id,
      actorType: turn.message.actor_type,
      actorId: turn.message.actor_id,
      sequence: BigInt(turn.message.sequence),
      attempt: Number(turn.message.attempt_count),
    }
    const renewalController = new AbortController()
    let renewalError: unknown
    const renewal = this.renewLease(turn, renewalController.signal).catch((error: unknown) => {
      renewalError = error
    })

    try {
      const oldObservables = this.readObservables(actor, definition)
      const before = stableJson(actorState(actor, definition.stateKeys))
      const query = this.isQuery(definition, turn.message.operation)
      const argumentsValue = jsonObject(JSON.parse(turn.message.arguments))
      const rawResult = await withActorContext({ actor, message: messageContext }, async () => {
        if (definition.stateKeys.includes(turn.message.operation)) {
          return (actor as unknown as Record<string, unknown>)[turn.message.operation]
        }
        return actor.invoke(turn.message.operation, argumentsValue)
      })
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
      renewalController.abort()
      await renewal
      if (renewalError) throw renewalError
      const completion = await this.repository.complete(turn, {
        state: committedState,
        stateVersion: definition.stateVersion,
        result,
        changedObservables,
        intents: actor.drainIntents(),
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
    } catch (error) {
      renewalController.abort()
      await renewal
      actor.discardIntents()
      if (error instanceof LostActivation) {
        this.emitInstrumentation("activation.lost", {
          ...messageInstrumentation(turn.message),
          durationMilliseconds: Date.now() - startedAt,
        })
        return
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
        return
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
    }
  }

  async close(): Promise<void> {
    if (this.running)
      throw new Error("abort runtime.run() and wait for it before closing the runtime")
    await this.callerWorker?.stop()
    await this.settings.database.close()
    clearDefaultRuntime(this)
  }

  async resetForTesting(): Promise<void> {
    if (this.running) throw new Error("abort runtime.run() before resetting test state")
    await this.callerWorker?.stop()
    this.callerWorker = undefined
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
      this.emitInstrumentation("effect.completed", effectInstrumentation(effect))
    } catch (error) {
      await this.repository.failEffect({
        effect,
        error,
        retryable: !(error instanceof NonRetryableError),
      })
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
    if (!deliver) throw new TypeError("broadcast is not configured")
    try {
      await deliver({
        actorType: broadcast.actor_type,
        actorId: broadcast.actor_id,
        instanceId: broadcast.instance_id,
        revision: String(broadcast.state_revision),
        observables: jsonObject(JSON.parse(broadcast.observables)),
      })
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
    })
  }

  private async renewLease(turn: ClaimedTurn, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await waitFor(this.settings.leaseRenewalIntervalMilliseconds, signal)
      if (signal.aborted) return
      await this.repository.renewTurn(turn)
    }
  }

  private async buildComponents(): Promise<LongRunningComponent[]> {
    const components: LongRunningComponent[] = [
      ...Array.from({ length: this.settings.workerCount }, () => this.worker()),
      ...Array.from({ length: this.settings.effectWorkerCount }, () => this.effectWorker()),
      ...Array.from({ length: this.settings.reminderSchedulerCount }, () =>
        this.reminderScheduler(),
      ),
      ...(this.settings.broadcast
        ? Array.from({ length: this.settings.broadcastWorkerCount }, () => this.broadcastWorker())
        : []),
    ]

    try {
      for (const { count, factory } of this.additionalComponents) {
        for (let index = 0; index < count; index += 1) {
          const component = factory()
          validateComponent(component)
          components.push(component)
        }
      }
      return components
    } catch (error) {
      for (const component of components) component.requestShutdown()
      await Promise.allSettled(components.map((component) => component.stop()))
      throw error
    }
  }

  private readObservables(actor: Actor, definition: ValidatedActorDefinition): JsonObject {
    const stateBefore = stableJson(actorState(actor, definition.stateKeys))
    const intentCount = actor.intentCount()
    const values = actor.observableValues()
    if (
      stableJson(actorState(actor, definition.stateKeys)) !== stateBefore ||
      actor.intentCount() !== intentCount
    ) {
      throw new QueryMutatedState("observables must not mutate actor state or stage durable work")
    }
    return values
  }

  private fetchActor(actorType: string): RegisteredActor {
    const actor = this.registry.get(actorType)
    if (!actor) throw new UnknownActorType(`unknown actor type ${actorType}`)
    return actor
  }

  private isQuery(definition: ValidatedActorDefinition, name: string): boolean {
    return definition.queries.includes(name)
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

export function createSolidObjects(configuration: SolidObjectsConfiguration): SolidObjectsRuntime {
  return new SolidObjectsRuntime(configuration)
}

export function configureSolidObjects(
  configuration: SolidObjectsConfiguration,
): SolidObjectsRuntime {
  const runtime = createSolidObjects(configuration)
  setDefaultRuntime(runtime)
  return runtime
}

function parseResult(value: string | null): JsonValue {
  if (value === null) return null
  return normalizeJson(JSON.parse(value))
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

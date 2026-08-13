import type { InvalidationEnvelope } from "./index.js"

const MAXIMUM_COMPONENTS_PER_ACTOR = 50

export type ComponentRefreshStrategy = "replace" | "morph"

export interface ComponentRegistration {
  actorType: string
  actorId: string
  target: string
  name: string
  key?: string | number
  observes: readonly string[]
  batch?: string
  strategy?: ComponentRefreshStrategy
}

export interface RegisteredComponent {
  actorType: string
  actorId: string
  target: string
  name: string
  key?: string
  observes: readonly string[]
  batch?: string
  strategy: ComponentRefreshStrategy
}

export interface ComponentRefreshRequest {
  actorType: string
  actorId: string
  instanceId: string
  revision: string
  batch?: string
  components: readonly RegisteredComponent[]
  signal: AbortSignal
}

export interface ComponentRefreshResult<Rendered> {
  target: string
  rendered: Rendered
}

export interface ComponentApplication<Rendered> {
  component: RegisteredComponent
  rendered: Rendered
  instanceId: string
  revision: string
}

export interface ComponentRefreshFailure {
  error: Error
  request: ComponentRefreshRequest
}

export interface ComponentRegistryOptions<Rendered> {
  refresh(request: ComponentRefreshRequest): Promise<readonly ComponentRefreshResult<Rendered>[]>
  apply(application: ComponentApplication<Rendered>): void
  onError?: (failure: ComponentRefreshFailure) => void
}

interface PendingRefresh {
  group: string
  actor: string
  actorType: string
  actorId: string
  instanceId: string
  revision: bigint
  batch?: string
  components: Map<string, RegisteredComponent>
}

interface ActiveRefresh {
  actor: string
  instanceId: string
  revision: bigint
  controller: AbortController
}

interface AppliedRevision {
  instanceId: string
  revision: bigint
}

export class SolidObjectsComponentRegistry<Rendered> {
  readonly #options: ComponentRegistryOptions<Rendered>
  readonly #components = new Map<string, RegisteredComponent>()
  readonly #componentsByActor = new Map<string, Set<string>>()
  readonly #received = new Map<string, AppliedRevision>()
  readonly #pending = new Map<string, PendingRefresh>()
  readonly #active = new Map<string, Set<ActiveRefresh>>()
  readonly #applied = new Map<string, AppliedRevision>()
  #flushScheduled = false
  #closed = false

  constructor(options: ComponentRegistryOptions<Rendered>) {
    this.#options = options
  }

  register(registration: ComponentRegistration): () => void {
    if (this.#closed) throw new Error("component registry is closed")
    const component = normalizeRegistration(registration)
    const identity = componentIdentity(component)
    if (this.#components.has(identity)) {
      throw new TypeError(`component ${component.name} with this key is already registered`)
    }
    if ([...this.#components.values()].some(({ target }) => target === component.target)) {
      throw new TypeError(`component target ${component.target} is already registered`)
    }
    const actor = actorIdentity(component)
    if ((this.#componentsByActor.get(actor)?.size ?? 0) >= MAXIMUM_COMPONENTS_PER_ACTOR) {
      throw new TypeError(
        `an actor may register at most ${MAXIMUM_COMPONENTS_PER_ACTOR} components`,
      )
    }
    this.#components.set(identity, component)
    const identities = this.#componentsByActor.get(actor) ?? new Set()
    identities.add(identity)
    this.#componentsByActor.set(actor, identities)
    return () => {
      if (this.#components.get(identity) !== component) return
      this.#components.delete(identity)
      identities.delete(identity)
      if (identities.size === 0) this.#componentsByActor.delete(actor)
      this.#applied.delete(component.target)
    }
  }

  invalidate(envelope: InvalidationEnvelope): void {
    if (this.#closed) return
    const actor = actorIdentity(envelope)
    const revision = BigInt(envelope.revision)
    const received = this.#received.get(actor)
    if (received?.instanceId === envelope.instanceId && revision < received.revision) return
    if (received !== undefined && received.instanceId !== envelope.instanceId) {
      this.resetActor(actor)
    }
    this.#received.set(actor, { instanceId: envelope.instanceId, revision })
    const changed = new Set(Object.keys(envelope.observables))
    const identities = this.#componentsByActor.get(actor)
    if (!identities || changed.size === 0) return
    for (const identity of identities) {
      const component = this.#components.get(identity)
      if (!component || !component.observes.some((observable) => changed.has(observable))) continue
      this.queue({ actor, component, envelope })
    }
    this.scheduleFlush()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pending.clear()
    for (const refreshes of this.#active.values()) {
      for (const refresh of refreshes) refresh.controller.abort()
    }
    this.#active.clear()
    this.#components.clear()
    this.#componentsByActor.clear()
    this.#received.clear()
    this.#applied.clear()
  }

  private queue(options: {
    actor: string
    component: RegisteredComponent
    envelope: InvalidationEnvelope
  }): void {
    const { actor, component, envelope } = options
    const group = refreshGroup(component)
    const revision = BigInt(envelope.revision)
    const existing = this.#pending.get(group)
    if (existing?.instanceId === envelope.instanceId && existing.revision === revision) {
      existing.components.set(component.target, component)
      return
    }
    this.#pending.set(group, {
      group,
      actor,
      actorType: envelope.actorType,
      actorId: envelope.actorId,
      instanceId: envelope.instanceId,
      revision,
      ...(component.batch === undefined ? {} : { batch: component.batch }),
      components: new Map([[component.target, component]]),
    })
  }

  private scheduleFlush(): void {
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    queueMicrotask(() => {
      this.#flushScheduled = false
      if (this.#closed) return
      const pending = [...this.#pending.values()]
      this.#pending.clear()
      for (const refresh of pending) void this.refresh(refresh)
    })
  }

  private async refresh(pending: PendingRefresh): Promise<void> {
    const controller = new AbortController()
    const active: ActiveRefresh = {
      actor: pending.actor,
      instanceId: pending.instanceId,
      revision: pending.revision,
      controller,
    }
    const refreshes = this.#active.get(pending.group) ?? new Set()
    for (const refresh of refreshes) {
      if (supersedes(active, refresh)) refresh.controller.abort()
    }
    refreshes.add(active)
    this.#active.set(pending.group, refreshes)
    const components = Object.freeze([...pending.components.values()])
    const request = Object.freeze({
      actorType: pending.actorType,
      actorId: pending.actorId,
      instanceId: pending.instanceId,
      revision: pending.revision.toString(),
      ...(pending.batch === undefined ? {} : { batch: pending.batch }),
      components,
      signal: controller.signal,
    })
    try {
      const results = await this.#options.refresh(request)
      if (
        controller.signal.aborted ||
        this.#received.get(pending.actor)?.instanceId !== pending.instanceId
      ) {
        return
      }
      this.apply({ pending, results })
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      this.report({
        error: error instanceof Error ? error : new Error("component refresh failed"),
        request,
      })
    } finally {
      refreshes.delete(active)
      if (refreshes.size === 0 && this.#active.get(pending.group) === refreshes) {
        this.#active.delete(pending.group)
      }
    }
  }

  private apply(options: {
    pending: PendingRefresh
    results: readonly ComponentRefreshResult<Rendered>[]
  }): void {
    const requested = options.pending.components
    const seen = new Set<string>()
    for (const result of options.results) {
      if (seen.has(result.target))
        throw new TypeError(`duplicate component result ${result.target}`)
      seen.add(result.target)
      const component = requested.get(result.target)
      if (!component) throw new TypeError(`unexpected component result ${result.target}`)
      if (this.#components.get(componentIdentity(component)) !== component) continue
      const current = this.#applied.get(result.target)
      if (
        current?.instanceId === options.pending.instanceId &&
        current.revision >= options.pending.revision
      ) {
        continue
      }
      this.#options.apply({
        component,
        rendered: result.rendered,
        instanceId: options.pending.instanceId,
        revision: options.pending.revision.toString(),
      })
      this.#applied.set(result.target, {
        instanceId: options.pending.instanceId,
        revision: options.pending.revision,
      })
    }
  }

  private resetActor(actor: string): void {
    for (const [group, pending] of this.#pending) {
      if (pending.actor === actor) this.#pending.delete(group)
    }
    const targets = new Set<string>()
    for (const identity of this.#componentsByActor.get(actor) ?? []) {
      const component = this.#components.get(identity)
      if (component) targets.add(component.target)
    }
    for (const target of targets) this.#applied.delete(target)
    for (const [group, refreshes] of this.#active) {
      if (![...refreshes].some((refresh) => refresh.actor === actor)) continue
      for (const refresh of refreshes) refresh.controller.abort()
      this.#active.delete(group)
    }
  }

  private report(failure: ComponentRefreshFailure): void {
    try {
      this.#options.onError?.(failure)
    } catch {}
  }
}

function normalizeRegistration(registration: ComponentRegistration): RegisteredComponent {
  const actorType = requiredString(registration.actorType, "actorType")
  const actorId = requiredString(registration.actorId, "actorId")
  const target = requiredString(registration.target, "target")
  const name = requiredString(registration.name, "name")
  if (!Array.isArray(registration.observes) || registration.observes.length === 0) {
    throw new TypeError("component observes must contain at least one observable")
  }
  const observes = Object.freeze([
    ...new Set(registration.observes.map((value) => requiredString(value, "observable"))),
  ])
  if (typeof registration.key === "number" && !Number.isFinite(registration.key)) {
    throw new TypeError("component key numbers must be finite")
  }
  const key = registration.key === undefined ? undefined : String(registration.key)
  const batch =
    registration.batch === undefined ? undefined : requiredString(registration.batch, "batch")
  const strategy = registration.strategy ?? "replace"
  if (strategy !== "replace" && strategy !== "morph") {
    throw new TypeError("component strategy must be replace or morph")
  }
  return Object.freeze({
    actorType,
    actorId,
    target,
    name,
    ...(key === undefined ? {} : { key }),
    observes,
    ...(batch === undefined ? {} : { batch }),
    strategy,
  })
}

function actorIdentity(actor: { actorType: string; actorId: string }): string {
  return JSON.stringify([actor.actorType, actor.actorId])
}

function componentIdentity(component: RegisteredComponent): string {
  return JSON.stringify([component.actorType, component.actorId, component.name, component.key])
}

function refreshGroup(component: RegisteredComponent): string {
  return JSON.stringify([
    component.actorType,
    component.actorId,
    component.batch === undefined ? component.target : `batch:${component.batch}`,
  ])
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function supersedes(current: ActiveRefresh, previous: ActiveRefresh): boolean {
  if (current.instanceId !== previous.instanceId) return true
  return current.revision > previous.revision
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

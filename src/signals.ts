import { Signal } from "signal-polyfill"
import type { RealtimeEnvelope } from "./browser/index.js"
import type { Actor } from "./actor.js"
import {
  installLiveSignals,
  type ActorReferenceCore,
  type ActorSnapshot,
  type LiveSignal,
} from "./reference.js"
import type { DeepReadonly, JsonValue } from "./types.js"

export type { ActorLiveSignals, LiveSignal } from "./reference.js"

export interface LiveSignalsConfiguration {
  lingerMilliseconds?: number
  retryMilliseconds?: number
}

const SNAPSHOT_KEY = "snapshot"
const PAYLOADS_KEY = "payloads"

let lingerMilliseconds = 1_000
let retryMilliseconds = 1_000
const openSessions = new Set<LiveActorEntry>()

export function configureLiveSignals(configuration: LiveSignalsConfiguration): void {
  if (configuration.lingerMilliseconds !== undefined) {
    if (
      !Number.isFinite(configuration.lingerMilliseconds) ||
      configuration.lingerMilliseconds < 0
    ) {
      throw new TypeError("lingerMilliseconds must be a non-negative number")
    }
    lingerMilliseconds = configuration.lingerMilliseconds
  }
  if (configuration.retryMilliseconds !== undefined) {
    if (!Number.isFinite(configuration.retryMilliseconds) || configuration.retryMilliseconds < 0) {
      throw new TypeError("retryMilliseconds must be a non-negative number")
    }
    retryMilliseconds = configuration.retryMilliseconds
  }
}

export function liveEntryCount(runtime: object): number {
  const entries = entriesByRuntime.get(runtime)
  if (!entries) return 0
  let alive = 0
  for (const reference of entries.values()) {
    if (reference.deref() !== undefined) alive += 1
  }
  return alive
}

export function activeLiveSubscriptionCount(): number {
  return openSessions.size
}

interface LiveSession {
  receive(request: object): Promise<void>
  close(): void
}

class LiveActorEntry {
  readonly #reference: ActorReferenceCore<Actor>
  readonly #states = new Map<string, Signal.State<DeepReadonly<JsonValue> | undefined>>()
  readonly #mirrors = new Map<string, LiveSignal<DeepReadonly<JsonValue> | undefined>>()
  readonly #snapshotState = new Signal.State<ActorSnapshot<Actor> | undefined>(undefined)
  #snapshotMirror: LiveSignal<ActorSnapshot<Actor> | undefined> | undefined
  readonly #payloadStates = new Map<string, Signal.State<DeepReadonly<JsonValue> | undefined>>()
  readonly #payloadMirrors = new Map<string, LiveSignal<DeepReadonly<JsonValue> | undefined>>()
  readonly #payloadWatcherCounts = new Map<string, number>()
  readonly #payloadFences = new Map<string, { instanceId: string; revision: bigint }>()
  #payloadsProxy: object | undefined
  #watcherCount = 0
  #snapshotWatcherCount = 0
  #session: LiveSession | undefined
  #linger: ReturnType<typeof setTimeout> | undefined
  #instanceId: string | undefined
  #revision = -1n
  #refreshing = false
  #refreshQueued = false
  #retry: ReturnType<typeof setTimeout> | undefined

  constructor(reference: ActorReferenceCore<Actor>) {
    this.#reference = reference
  }

  signalFor(name: string): LiveSignal<DeepReadonly<JsonValue> | undefined> {
    const existing = this.#mirrors.get(name)
    if (existing) return existing
    const state = this.stateFor(name)
    const mirror = new Signal.Computed(() => state.get(), {
      [Signal.subtle.watched]: () => this.retain({ snapshot: false }),
      [Signal.subtle.unwatched]: () => this.release({ snapshot: false }),
    })
    this.#mirrors.set(name, mirror)
    return mirror
  }

  payloadsProxy(): object {
    this.#payloadsProxy ??= new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property !== "string") return undefined
          return this.payloadSignalFor(property)
        },
        has: (_target, property) => typeof property === "string",
      },
    )
    return this.#payloadsProxy
  }

  payloadSignalFor(name: string): LiveSignal<DeepReadonly<JsonValue> | undefined> {
    const existing = this.#payloadMirrors.get(name)
    if (existing) return existing
    const state = this.payloadStateFor(name)
    const mirror = new Signal.Computed(() => state.get(), {
      [Signal.subtle.watched]: () => {
        this.#payloadWatcherCounts.set(name, (this.#payloadWatcherCounts.get(name) ?? 0) + 1)
        this.retain({ snapshot: false, payloadName: name })
      },
      [Signal.subtle.unwatched]: () => {
        const count = (this.#payloadWatcherCounts.get(name) ?? 1) - 1
        if (count <= 0) this.#payloadWatcherCounts.delete(name)
        else this.#payloadWatcherCounts.set(name, count)
        this.release({ snapshot: false })
      },
    })
    this.#payloadMirrors.set(name, mirror)
    return mirror
  }

  private payloadStateFor(name: string) {
    let state = this.#payloadStates.get(name)
    if (!state) {
      state = new Signal.State<DeepReadonly<JsonValue> | undefined>(undefined)
      this.#payloadStates.set(name, state)
    }
    return state
  }

  snapshotSignal(): LiveSignal<ActorSnapshot<Actor> | undefined> {
    this.#snapshotMirror ??= new Signal.Computed(() => this.#snapshotState.get(), {
      [Signal.subtle.watched]: () => this.retain({ snapshot: true }),
      [Signal.subtle.unwatched]: () => this.release({ snapshot: true }),
    })
    return this.#snapshotMirror
  }

  private stateFor(name: string) {
    let state = this.#states.get(name)
    if (!state) {
      state = new Signal.State<DeepReadonly<JsonValue> | undefined>(undefined)
      this.#states.set(name, state)
    }
    return state
  }

  private retain(options: { snapshot: boolean; payloadName?: string }): void {
    this.#watcherCount += 1
    if (options.snapshot) this.#snapshotWatcherCount += 1
    if (this.#linger !== undefined) {
      clearTimeout(this.#linger)
      this.#linger = undefined
    }
    if (!this.#session) this.open()
    else if (options.payloadName !== undefined) this.sendSubscribe(this.#session)
    else if (options.snapshot) void this.refreshSnapshot()
  }

  private release(options: { snapshot: boolean }): void {
    this.#watcherCount -= 1
    if (options.snapshot) this.#snapshotWatcherCount -= 1
    if (this.#watcherCount > 0) return
    if (this.#linger !== undefined) clearTimeout(this.#linger)
    this.#linger = setTimeout(() => {
      this.#linger = undefined
      if (this.#watcherCount === 0) this.close()
    }, lingerMilliseconds)
  }

  private open(): void {
    if (this.#retry !== undefined) {
      clearTimeout(this.#retry)
      this.#retry = undefined
    }
    const session = this.#reference.runtime.realtime.connect({
      authorizationContext: undefined,
      send: (envelope: RealtimeEnvelope) => this.receive(envelope),
    }) as LiveSession
    this.#session = session
    openSessions.add(this)
    void this.sendSubscribe(session)
      .then(() => this.refreshSnapshot())
      .catch((error: unknown) => {
        this.#reference.runtime.settings.logger.warn({
          event: "solid_objects.live_signals.subscribe_failed",
          actorType: this.#reference.actorType,
          actorId: this.#reference.actorId,
          error: error instanceof Error ? error.name : "Error",
        })
        if (this.#session !== session) return
        this.close()
        if (this.#watcherCount === 0) return
        this.#retry = setTimeout(() => {
          this.#retry = undefined
          if (this.#watcherCount > 0 && !this.#session) this.open()
        }, retryMilliseconds)
      })
  }

  private sendSubscribe(session: LiveSession): Promise<void> {
    const payloadNames = [...this.#payloadWatcherCounts.keys()]
    return session.receive({
      version: 1,
      action: "subscribe",
      actorType: this.#reference.actorType,
      actorId: this.#reference.actorId,
      ...(payloadNames.length > 0 ? { payloads: payloadNames } : {}),
    })
  }

  private close(): void {
    if (this.#retry !== undefined) {
      clearTimeout(this.#retry)
      this.#retry = undefined
    }
    const session = this.#session
    if (!session) return
    this.#session = undefined
    openSessions.delete(this)
    session.close()
  }

  private receive(envelope: RealtimeEnvelope): void {
    if (envelope.kind === "payload") {
      this.receivePayload(envelope)
      return
    }
    if (envelope.kind !== "invalidation") return
    const revision = BigInt(envelope.revision)
    if (this.#instanceId === envelope.instanceId && revision <= this.#revision) return
    this.#instanceId = envelope.instanceId
    this.#revision = revision
    for (const [name, value] of Object.entries(envelope.observables)) {
      this.stateFor(name).set(value as DeepReadonly<JsonValue>)
    }
    void this.refreshSnapshot()
  }

  private receivePayload(envelope: RealtimeEnvelope & { kind: "payload" }): void {
    const revision = BigInt(envelope.revision)
    const fence = this.#payloadFences.get(envelope.name)
    if (fence && fence.instanceId === envelope.instanceId && revision <= fence.revision) return
    this.#payloadFences.set(envelope.name, { instanceId: envelope.instanceId, revision })
    this.payloadStateFor(envelope.name).set(envelope.payload as DeepReadonly<JsonValue>)
  }

  private async refreshSnapshot(): Promise<void> {
    if (this.#snapshotWatcherCount === 0) return
    if (this.#refreshing) {
      this.#refreshQueued = true
      return
    }
    this.#refreshing = true
    try {
      const snapshot = await this.#reference.snapshot()
      this.#snapshotState.set(snapshot as ActorSnapshot<Actor>)
    } catch (error) {
      this.#reference.runtime.settings.logger.warn({
        event: "solid_objects.live_signals.snapshot_failed",
        actorType: this.#reference.actorType,
        actorId: this.#reference.actorId,
        error: error instanceof Error ? error.name : "Error",
      })
    } finally {
      this.#refreshing = false
      if (this.#refreshQueued) {
        this.#refreshQueued = false
        void this.refreshSnapshot()
      }
    }
  }
}

const entriesByRuntime = new WeakMap<object, Map<string, WeakRef<LiveActorEntry>>>()

const collectedEntries = new FinalizationRegistry(
  (held: { entries: Map<string, WeakRef<LiveActorEntry>>; key: string }) => {
    if (held.entries.get(held.key)?.deref() === undefined) held.entries.delete(held.key)
  },
)

installLiveSignals((reference) => {
  let entries = entriesByRuntime.get(reference.runtime)
  if (!entries) {
    entries = new Map()
    entriesByRuntime.set(reference.runtime, entries)
  }
  const key = `${reference.actorType} ${reference.actorId}`
  let entry = entries.get(key)?.deref()
  if (!entry) {
    entry = new LiveActorEntry(reference)
    entries.set(key, new WeakRef(entry))
    collectedEntries.register(entry, { entries, key })
  }
  const resolved = entry
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined
        if (property === SNAPSHOT_KEY) return resolved.snapshotSignal()
        if (property === PAYLOADS_KEY) return resolved.payloadsProxy()
        return resolved.signalFor(property)
      },
      has(_target, property) {
        return typeof property === "string"
      },
    },
  )
})

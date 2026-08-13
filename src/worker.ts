import { randomUUID } from "node:crypto"
import type { Actor } from "./actor.js"
import { LostActivation } from "./errors.js"
import type { ActivationLease, ClaimedTurn } from "./records.js"
import type { SolidObjectsRuntime } from "./runtime.js"

interface CachedActivation {
  actor: Actor
  turn: ClaimedTurn
  lastUsedAt: number
  renewAt: number
}

export class Worker {
  readonly processId = randomUUID()
  private registered = false
  private stopping = false
  private readonly activations = new Map<string, CachedActivation>()

  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async runOnce(options: { activationRetention?: "retain" | "release" } = {}): Promise<number> {
    try {
      if (this.stopping) return 0
      await this.ensureRegistered()
      await this.runtime.repository.heartbeatProcess(this.processId)
      await this.maintainCachedActivations()
      let cached: CachedActivation | undefined = await this.claimCachedActivation()
      let turn = cached?.turn ?? (await this.runtime.repository.claim(this.processId))
      if (!turn) return 0
      let processed = 0
      const passStartedAt = performance.now()
      let passExhausted = false
      while (turn) {
        const execution = await this.runtime.executeTurn(turn, cached?.actor)
        processed += 1
        if (!execution.retainActivation || !execution.actor) {
          await this.releaseActivation({
            turn,
            ...(execution.actor === undefined ? {} : { actor: execution.actor }),
            lifecycle: execution.activated ? "activated" : "unactivated",
          })
          return processed
        }
        const now = performance.now()
        cached = {
          actor: execution.actor,
          turn,
          lastUsedAt: now,
          renewAt: now + this.runtime.settings.leaseRenewalIntervalMilliseconds,
        }
        this.activations.set(turn.instance.id, cached)
        passExhausted =
          processed >= this.runtime.settings.maxMessagesPerActivationPass ||
          performance.now() - passStartedAt >=
            this.runtime.settings.maxActivationDurationMilliseconds
        if (passExhausted) break
        turn = await this.runtime.repository.claim(this.processId, {
          activation: activationLease(cached.turn),
        })
      }
      if (passExhausted) {
        if (!cached) return processed
        const yielded = await this.runtime.repository.yieldReadyMessages(cached.turn.instance.id)
        if (yielded > 0) {
          this.runtime.emitInstrumentation("activation.yielded", {
            actorType: cached.turn.message.actor_type,
            actorId: cached.turn.message.actor_id,
            processed,
            readyMessages: yielded,
          })
        }
        await this.releaseActivation({
          turn: cached.turn,
          actor: cached.actor,
          lifecycle: "activated",
        })
      }
      return processed
    } finally {
      if (options.activationRetention === "release") await this.releaseCachedActivations()
    }
  }

  async runUntilIdle(options: { maxTurns?: number } = {}): Promise<number> {
    const maxTurns = options.maxTurns ?? 10_000
    let processed = 0
    try {
      while (!this.stopping && processed < maxTurns) {
        const count = await this.runOnce()
        if (count === 0) break
        processed += count
      }
      return processed
    } finally {
      await this.releaseCachedActivations()
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureRegistered()
    while (!signal.aborted && !this.stopping) {
      const wakeUp = await this.runtime.settings.wakeUp.watch("actors")
      const processed = await this.runOnce()
      if (processed === 0) {
        await wakeUp.wait({
          timeoutMilliseconds: Math.min(
            this.runtime.settings.pollingIntervalMilliseconds,
            this.runtime.settings.leaseRenewalIntervalMilliseconds,
          ),
          signal,
        })
      }
    }
    await this.stop()
  }

  requestShutdown(): void {
    this.stopping = true
  }

  stopped(): boolean {
    return this.stopping
  }

  async stop(): Promise<void> {
    if (this.stopping && !this.registered) return
    this.stopping = true
    if (this.registered) await this.runtime.repository.startDrainingProcess(this.processId)
    await this.releaseCachedActivations()
    if (this.registered) {
      await this.runtime.repository.stopProcess(this.processId)
      this.registered = false
    }
  }

  private async releaseCachedActivations(): Promise<void> {
    for (const activation of [...this.activations.values()]) {
      await this.releaseActivation({
        turn: activation.turn,
        actor: activation.actor,
        lifecycle: "activated",
      })
    }
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) return
    await this.runtime.repository.registerProcess(this.processId, "worker")
    this.registered = true
  }

  private async claimCachedActivation(): Promise<CachedActivation | undefined> {
    for (const activation of this.activations.values()) {
      const turn = await this.runtime.repository.claim(this.processId, {
        activation: activationLease(activation.turn),
      })
      if (turn) return { ...activation, turn }
    }
    return undefined
  }

  private async maintainCachedActivations(): Promise<void> {
    const now = performance.now()
    for (const activation of [...this.activations.values()]) {
      if (
        now - activation.lastUsedAt >=
        this.runtime.settings.idleDeactivationTimeoutMilliseconds
      ) {
        await this.releaseActivation({
          turn: activation.turn,
          actor: activation.actor,
          lifecycle: "activated",
        })
        continue
      }
      if (now < activation.renewAt) continue
      try {
        await this.runtime.repository.renewActivation(activationLease(activation.turn))
        activation.renewAt = now + this.runtime.settings.leaseRenewalIntervalMilliseconds
      } catch (error) {
        if (!(error instanceof LostActivation)) throw error
        await this.releaseActivation({
          turn: activation.turn,
          actor: activation.actor,
          lifecycle: "activated",
        })
      }
    }
  }

  private async releaseActivation(options: {
    turn: ClaimedTurn
    actor?: Actor
    lifecycle: "activated" | "unactivated"
  }): Promise<void> {
    this.activations.delete(options.turn.instance.id)
    await this.runtime.deactivateActor(options)
  }
}

function activationLease(turn: ClaimedTurn): ActivationLease {
  return {
    instanceId: turn.instance.id,
    processId: turn.processId,
    activationToken: turn.activationToken,
    activationGeneration: turn.activationGeneration,
  }
}

export function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

export async function withProcessHeartbeat<Result>(options: {
  runtime: SolidObjectsRuntime
  processId: string
  operation: () => Promise<Result>
}): Promise<Result> {
  const { runtime, processId, operation } = options
  const controller = new AbortController()
  let heartbeatError: unknown
  const heartbeat = heartbeatUntilStopped({ runtime, processId, signal: controller.signal }).catch(
    (error: unknown) => {
      heartbeatError = error
    },
  )
  try {
    const result = await operation()
    controller.abort()
    await heartbeat
    if (heartbeatError) throw heartbeatError
    return result
  } finally {
    controller.abort()
    await heartbeat
  }
}

async function heartbeatUntilStopped(options: {
  runtime: SolidObjectsRuntime
  processId: string
  signal: AbortSignal
}): Promise<void> {
  const { runtime, processId, signal } = options
  while (!signal.aborted) {
    await waitFor(runtime.settings.processHeartbeatIntervalMilliseconds, signal)
    if (signal.aborted) return
    await runtime.repository.heartbeatProcess(processId)
  }
}

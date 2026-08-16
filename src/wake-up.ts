export type WakeUpRole = "actors" | "effects" | "reminders" | "broadcasts"

export interface WakeUpWaitOptions {
  timeoutMilliseconds: number
  signal?: AbortSignal
}

export interface WakeUpWatch {
  wait(options: WakeUpWaitOptions): Promise<boolean | void>
}

export interface WakeUpAdapter {
  watch(role: WakeUpRole): WakeUpWatch | Promise<WakeUpWatch>
  notify(role: WakeUpRole): void | Promise<void>
  close(): void | Promise<void>
}

export class InProcessWakeUpAdapter implements WakeUpAdapter {
  private readonly generations = new Map<WakeUpRole, number>()
  private readonly waiters = new Map<WakeUpRole, Set<(notified: boolean) => void>>()
  private closed = false

  watch(role: WakeUpRole): WakeUpWatch {
    const generation = this.generation(role)
    return {
      wait: (options) => this.wait({ role, generation, ...options }),
    }
  }

  notify(role: WakeUpRole): void {
    if (this.closed) return
    this.generations.set(role, this.generation(role) + 1)
    const waiters = this.waiters.get(role)
    if (!waiters) return
    this.waiters.delete(role)
    for (const wake of waiters) wake(true)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const wake of waiters) wake(false)
    }
    this.waiters.clear()
  }

  private wait(options: {
    role: WakeUpRole
    generation: number
    timeoutMilliseconds: number
    signal?: AbortSignal
  }): Promise<boolean> {
    if (this.closed || options.signal?.aborted) return Promise.resolve(false)
    if (this.generation(options.role) !== options.generation) return Promise.resolve(true)

    return new Promise((resolve) => {
      let settled = false
      const waiters = this.waiters.get(options.role) ?? new Set()
      const finish = (notified: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        waiters.delete(finish)
        if (waiters.size === 0) this.waiters.delete(options.role)
        options.signal?.removeEventListener("abort", abort)
        resolve(notified)
      }
      const abort = () => finish(false)
      const timeout = setTimeout(() => finish(false), options.timeoutMilliseconds)
      waiters.add(finish)
      this.waiters.set(options.role, waiters)
      options.signal?.addEventListener("abort", abort, { once: true })
      if (
        this.closed ||
        options.signal?.aborted ||
        this.generation(options.role) !== options.generation
      ) {
        finish(!this.closed && !options.signal?.aborted)
      }
    })
  }

  private generation(role: WakeUpRole): number {
    return this.generations.get(role) ?? 0
  }
}

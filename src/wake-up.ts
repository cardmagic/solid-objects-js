export type WakeUpRole = "actors" | "effects" | "reminders" | "broadcasts"

export interface WakeUpWaitOptions {
  timeoutMilliseconds: number
  signal?: AbortSignal
}

export interface WakeUpWatch {
  wait(options: WakeUpWaitOptions): Promise<void>
}

export interface WakeUpAdapter {
  watch(role: WakeUpRole): WakeUpWatch
  notify(role: WakeUpRole): void | Promise<void>
  close(): void | Promise<void>
}

export class InProcessWakeUpAdapter implements WakeUpAdapter {
  private readonly generations = new Map<WakeUpRole, number>()
  private readonly waiters = new Map<WakeUpRole, Set<() => void>>()
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
    for (const wake of waiters) wake()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const wake of waiters) wake()
    }
    this.waiters.clear()
  }

  private wait(options: {
    role: WakeUpRole
    generation: number
    timeoutMilliseconds: number
    signal?: AbortSignal
  }): Promise<void> {
    if (this.closed || options.signal?.aborted) return Promise.resolve()
    if (this.generation(options.role) !== options.generation) return Promise.resolve()

    return new Promise((resolve) => {
      let settled = false
      const waiters = this.waiters.get(options.role) ?? new Set()
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        waiters.delete(finish)
        if (waiters.size === 0) this.waiters.delete(options.role)
        options.signal?.removeEventListener("abort", finish)
        resolve()
      }
      const timeout = setTimeout(finish, options.timeoutMilliseconds)
      waiters.add(finish)
      this.waiters.set(options.role, waiters)
      options.signal?.addEventListener("abort", finish, { once: true })
      if (
        this.closed ||
        options.signal?.aborted ||
        this.generation(options.role) !== options.generation
      ) {
        finish()
      }
    })
  }

  private generation(role: WakeUpRole): number {
    return this.generations.get(role) ?? 0
  }
}

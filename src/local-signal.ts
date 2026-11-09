export interface LocalSignalWaitOptions {
  timeoutMilliseconds: number
  signal?: AbortSignal
}

export interface LocalSignalWatch {
  wait(options: LocalSignalWaitOptions): Promise<boolean>
}

export class LocalSignal {
  private generation = 0
  private readonly wakers = new Set<() => void>()

  watch(): LocalSignalWatch {
    const generation = this.generation
    return { wait: (options) => this.wait({ generation, ...options }) }
  }

  notify(): void {
    this.generation += 1
    const wakers = [...this.wakers]
    this.wakers.clear()
    for (const wake of wakers) wake()
  }

  private wait(options: LocalSignalWaitOptions & { generation: number }): Promise<boolean> {
    if (options.signal?.aborted) return Promise.resolve(false)
    if (this.generation !== options.generation) return Promise.resolve(true)

    return new Promise((resolve) => {
      const finish = (notified: boolean) => {
        clearTimeout(timeout)
        this.wakers.delete(wake)
        options.signal?.removeEventListener("abort", abort)
        resolve(notified)
      }
      const wake = () => finish(true)
      const abort = () => finish(false)
      const timeout = setTimeout(() => finish(false), options.timeoutMilliseconds)
      this.wakers.add(wake)
      options.signal?.addEventListener("abort", abort, { once: true })
    })
  }
}

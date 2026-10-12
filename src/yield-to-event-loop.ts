let yieldToHost = (): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function registerEventLoopYield(callback: () => Promise<void>): void {
  yieldToHost = callback
}

export function yieldToEventLoop(): Promise<void> {
  return yieldToHost()
}

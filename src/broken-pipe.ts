import type { EventEmitter } from "node:events"

export function ignoreBrokenPipe(
  stream: EventEmitter,
  options: { onBrokenPipe: () => void },
): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error
    options.onBrokenPipe()
  })
}

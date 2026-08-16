import { appendFile, access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Actor } from "solid-objects"

export class RecoveryCounter extends Actor {
  static override readonly actorType = "RecoveryCounter"

  count = 0

  async recover({ controlDirectory }: { controlDirectory: string }): Promise<number> {
    const message = this.currentMessage
    if (!message) throw new Error("recover requires a durable message")
    const attempt = message.attempt
    await appendFile(
      join(controlDirectory, "external-effects.jsonl"),
      `${JSON.stringify({ messageId: message.id, attempt, processId: process.pid })}\n`,
    )
    await writeFile(join(controlDirectory, `started-${attempt}-${process.pid}`), "")
    process.send?.({ event: "operation.started", attempt, processId: process.pid })
    if (attempt === 1) await waitForFile(join(controlDirectory, "release-first-attempt"))
    this.count += 1
    return this.count
  }

  async serialize({ controlDirectory }: { controlDirectory: string }): Promise<number> {
    const message = this.currentMessage
    if (!message) throw new Error("serialize requires a durable message")
    await appendFile(
      join(controlDirectory, "serialization.jsonl"),
      `${JSON.stringify({ event: "start", messageId: message.id, at: Date.now() })}\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    this.count += 1
    await appendFile(
      join(controlDirectory, "serialization.jsonl"),
      `${JSON.stringify({ event: "finish", messageId: message.id, at: Date.now() })}\n`,
    )
    return this.count
  }
}

async function waitForFile(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

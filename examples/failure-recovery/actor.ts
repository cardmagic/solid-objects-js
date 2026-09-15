import { appendFile, access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Actor, type EffectHandle, type EffectRetiredPayload } from "solid-objects"

export class RecoverableReport extends Actor {
  static override readonly actorType = "RecoverableReport"
  exportEffect: EffectHandle | null = null
  recoveryCount = 0

  start(): void {
    this.exportEffect = this.emit("build_report", {
      arguments: { revision: 1 },
      onRecovery: "recoverExport",
    })
  }

  recoverExport(payload: EffectRetiredPayload<{ revision: number }>): void {
    if (payload.effectId !== this.exportEffect?.id || payload.arguments.revision !== 1) return
    this.recoveryCount += 1
  }
}

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
    // The attempt and the process identify the execution, so a start pairs with
    // its own finish even when a superseded attempt outlives its replacement.
    const execution = { messageId: message.id, attempt: message.attempt, processId: process.pid }
    const path = join(controlDirectory, "serialization.jsonl")
    await appendFile(path, `${JSON.stringify({ event: "start", ...execution, at: Date.now() })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    this.count += 1
    await appendFile(path, `${JSON.stringify({ event: "finish", ...execution, at: Date.now() })}\n`)
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

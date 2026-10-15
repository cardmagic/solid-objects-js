import { Actor, type EffectSuccessPayload } from "solid-objects"

export const FOLLOW_UP_MILLISECONDS = 2 * 60 * 60 * 1000

const KEPT_ENTRIES = 50

export type Entry = { role: "user" | "tool" | "assistant"; content: string }

type ReplyArguments = { turn: number; history: Entry[] }
type ReplyResult = { content: string }

export class AgentSession extends Actor {
  static override readonly actorType = "AgentSession"

  history: Entry[] = []
  turn = 0
  followUps: string[] = []

  receive({ role, content }: { role: "user" | "tool"; content: string }): { turn: number } {
    this.#append({ role, content })
    return { turn: this.turn }
  }

  followUpLater({ topic }: { topic: string }): void {
    this.schedule({ at: new Date(Date.now() + FOLLOW_UP_MILLISECONDS), key: topic }).followUp({
      topic,
    })
  }

  followUp({ topic }: { topic: string }): void {
    this.followUps = [...this.followUps, topic]
    this.#append({ role: "tool", content: `Follow-up due: ${topic}` })
  }

  replied({ arguments: reply, result }: EffectSuccessPayload<ReplyArguments, ReplyResult>): void {
    if (reply.turn !== this.turn) return
    this.history = [...this.history, { role: "assistant" as const, content: result.content }].slice(
      -KEPT_ENTRIES,
    )
  }

  #append(entry: Entry): void {
    this.history = [...this.history, entry].slice(-KEPT_ENTRIES)
    this.turn += 1
    this.emit("model_reply", {
      arguments: { turn: this.turn, history: this.history },
      onSuccess: "replied",
    })
  }
}

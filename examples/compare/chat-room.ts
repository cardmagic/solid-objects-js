import { Actor } from "solid-objects"

export const ARCHIVE_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1000

const KEPT_MESSAGES = 200

export type ChatMessage = { sequence: number; authorId: string; text: string }

export class ChatRoom extends Actor {
  static override readonly actorType = "ChatRoom"

  members: string[] = []
  messages: ChatMessage[] = []
  nextSequence = 1
  lastRead: Record<string, number> = {}
  pinned: ChatMessage | null = null
  activity = 0
  archived = false

  get unreadCounts(): Record<string, number> {
    const latest = this.nextSequence - 1
    return Object.fromEntries(
      this.members.map((memberId) => [memberId, latest - (this.lastRead[memberId] ?? 0)]),
    )
  }

  join({ memberId }: { memberId: string }): void {
    this.#requireOpen()
    if (this.members.includes(memberId)) return
    this.members = [...this.members, memberId]
    this.lastRead = { ...this.lastRead, [memberId]: this.nextSequence - 1 }
    this.#armArchive()
  }

  post({ authorId, text }: { authorId: string; text: string }): { sequence: number } {
    this.#requireMember(authorId)
    const sequence = this.nextSequence
    this.nextSequence += 1
    this.messages = [...this.messages, { sequence, authorId, text }].slice(-KEPT_MESSAGES)
    this.lastRead = { ...this.lastRead, [authorId]: sequence }
    this.#armArchive()
    return { sequence }
  }

  markRead({ memberId, sequence }: { memberId: string; sequence: number }): void {
    this.#requireMember(memberId)
    const current = this.lastRead[memberId] ?? 0
    this.lastRead = {
      ...this.lastRead,
      [memberId]: Math.min(Math.max(current, sequence), this.nextSequence - 1),
    }
  }

  pin({ memberId, sequence }: { memberId: string; sequence: number }): void {
    this.#requireMember(memberId)
    const message = this.messages.find((candidate) => candidate.sequence === sequence)
    if (!message) this.reject("unknown_message", { message: "That message is not in the room" })
    this.pinned = message
    this.#armArchive()
  }

  archiveIfIdle({ activity }: { activity: number }): void {
    if (activity !== this.activity) return
    this.archived = true
  }

  #requireMember(memberId: string): void {
    this.#requireOpen()
    if (!this.members.includes(memberId)) {
      this.reject("not_a_member", { message: "Join the room first" })
    }
  }

  #requireOpen(): void {
    if (this.archived) this.reject("archived", { message: "The room is archived" })
  }

  #armArchive(): void {
    this.activity += 1
    this.schedule({ at: new Date(Date.now() + ARCHIVE_AFTER_MILLISECONDS) }).archiveIfIdle({
      activity: this.activity,
    })
  }
}

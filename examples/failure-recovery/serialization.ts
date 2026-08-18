import assert from "node:assert/strict"

export interface SerializationEvent {
  event: "start" | "finish"
  messageId: string
  at: number
}

export interface SerializationProof {
  executions: number
  retried: boolean
  overlapped: boolean
}

export function parseSerializationEvent(line: string): SerializationEvent {
  const event = JSON.parse(line) as Partial<SerializationEvent>
  if (
    (event.event !== "start" && event.event !== "finish") ||
    typeof event.messageId !== "string" ||
    typeof event.at !== "number"
  ) {
    throw new TypeError("invalid serialization event")
  }
  return { event: event.event, messageId: event.messageId, at: event.at }
}

// One identity commits one state transition at a time. The control file is
// written outside the transaction, so it records execution attempts rather than
// commits: a worker that loses its lease keeps running until it notices, and
// its replacement executes the same message again. A superseded attempt may
// therefore overlap anything, because its write is fenced out and the committed
// state is what proves it.
//
// The surviving attempts are the ones that count, so the last attempt of each
// message must still have the identity to itself.
export function assertSerializedExecution(
  events: readonly SerializationEvent[],
  options: { messageCount: number },
): SerializationProof {
  const ordered = [...events].sort((left, right) => left.at - right.at)

  const lastStartedAt = new Map<string, number>()
  for (const event of ordered) {
    if (event.event === "start") lastStartedAt.set(event.messageId, event.at)
  }

  const open = new Map<string, number[]>()
  const surviving = new Set<string>()
  let running = 0
  let concurrent = 0
  let executions = 0

  for (const event of ordered) {
    if (event.event === "start") {
      open.set(event.messageId, [...(open.get(event.messageId) ?? []), event.at])
      executions += 1
      running += 1
      concurrent = Math.max(concurrent, running)
      if (event.at === lastStartedAt.get(event.messageId)) {
        surviving.add(event.messageId)
        assert.equal(
          surviving.size,
          1,
          `${[...surviving].join(" and ")} overlap, and neither was superseded by a retry`,
        )
      }
      continue
    }
    const openForMessage = open.get(event.messageId) ?? []
    assert(openForMessage.length > 0, `finish of ${event.messageId} has no matching start`)
    const startedAt = openForMessage.pop()
    open.set(event.messageId, openForMessage)
    running -= 1
    if (startedAt === lastStartedAt.get(event.messageId)) surviving.delete(event.messageId)
  }

  assert.equal(running, 0, "an execution never wrote a finish")

  const messageIds = new Set(ordered.map((event) => event.messageId))
  assert.equal(
    messageIds.size,
    options.messageCount,
    `expected ${options.messageCount} messages to run, saw ${messageIds.size}`,
  )

  return {
    executions,
    retried: executions > options.messageCount,
    overlapped: concurrent > 1,
  }
}

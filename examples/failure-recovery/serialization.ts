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
// its replacement executes the same message again. Those two attempts can
// overlap in this log, and the fenced write is what stops them both counting.
// The committed state is the assertion that proves it.
//
// Without a retry there is no stale owner, so nothing excuses an overlap and
// the proof still demands strict serialization.
export function assertSerializedExecution(
  events: readonly SerializationEvent[],
  options: { messageCount: number },
): SerializationProof {
  const ordered = [...events].sort((left, right) => left.at - right.at)

  const open = new Map<string, number>()
  let running = 0
  let concurrent = 0
  let executions = 0

  for (const event of ordered) {
    if (event.event === "start") {
      open.set(event.messageId, (open.get(event.messageId) ?? 0) + 1)
      executions += 1
      running += 1
      concurrent = Math.max(concurrent, running)
      continue
    }
    const openForMessage = open.get(event.messageId) ?? 0
    assert(openForMessage > 0, `finish of ${event.messageId} has no matching start`)
    open.set(event.messageId, openForMessage - 1)
    running -= 1
  }

  assert.equal(running, 0, "an execution never wrote a finish")

  const messageIds = new Set(ordered.map((event) => event.messageId))
  assert.equal(
    messageIds.size,
    options.messageCount,
    `expected ${options.messageCount} messages to run, saw ${messageIds.size}`,
  )

  const retried = executions > options.messageCount
  if (!retried) {
    assert.equal(concurrent, 1, "executions overlapped without a lost lease to explain it")
  }

  return { executions, retried, overlapped: concurrent > 1 }
}

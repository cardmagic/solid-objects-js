import assert from "node:assert/strict"

export interface SerializationEvent {
  event: "start" | "finish"
  messageId: string
  at: number
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

// One identity executes one operation at a time. A worker that loses its lease
// mid-operation leaves the replacement to execute the same message again, so
// the proof counts the messages that ran and the executions that overlapped,
// not the executions themselves.
export function assertSerializedExecution(
  events: readonly SerializationEvent[],
  options: { messageCount: number },
): void {
  const ordered = [...events].sort((left, right) => left.at - right.at)

  let open: string | undefined
  for (const event of ordered) {
    if (event.event === "start") {
      assert.equal(
        open,
        undefined,
        `execution of ${event.messageId} overlaps the open execution of ${open}`,
      )
      open = event.messageId
      continue
    }
    assert.equal(event.messageId, open, `finish of ${event.messageId} has no matching start`)
    open = undefined
  }
  assert.equal(open, undefined, `execution of ${open} never wrote a finish`)

  const messageIds = new Set(ordered.map((event) => event.messageId))
  assert.equal(
    messageIds.size,
    options.messageCount,
    `expected ${options.messageCount} messages to run, saw ${messageIds.size}`,
  )
}

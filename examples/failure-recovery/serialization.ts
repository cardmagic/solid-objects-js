import assert from "node:assert/strict"

export interface SerializationEvent {
  event: "start" | "finish"
  messageId: string
  attempt: number
  processId: number
  at: number
}

export interface SerializationProof {
  executions: number
  retried: boolean
  supersededOverlap: boolean
}

interface Execution {
  messageId: string
  attempt: number
  processId: number
  startedAt: number
  finishedAt: number
}

export function parseSerializationEvent(line: string): SerializationEvent {
  const event = JSON.parse(line) as Partial<SerializationEvent>
  if (
    (event.event !== "start" && event.event !== "finish") ||
    typeof event.messageId !== "string" ||
    typeof event.attempt !== "number" ||
    typeof event.processId !== "number" ||
    typeof event.at !== "number"
  ) {
    throw new TypeError("invalid serialization event")
  }
  return {
    event: event.event,
    messageId: event.messageId,
    attempt: event.attempt,
    processId: event.processId,
    at: event.at,
  }
}

// One identity commits one state transition at a time. The control file is
// written outside the transaction, so it records execution attempts rather than
// commits: a worker that loses its lease keeps running until it notices, and its
// replacement executes the same message under a higher attempt. The superseded
// attempt may therefore overlap anything, because its write is fenced out and
// the committed state is what proves it.
//
// Each event carries its attempt and process, so a start pairs with its own
// finish rather than with whichever finish arrived next. Without that, a
// superseded attempt finishing late reads as its replacement finishing, and a
// second message could then overlap a replacement that is still running.
export function assertSerializedExecution(
  events: readonly SerializationEvent[],
  options: { messageCount: number },
): SerializationProof {
  const executions = pairExecutions(events)

  const messageIds = new Set(executions.map((execution) => execution.messageId))
  assert.equal(
    messageIds.size,
    options.messageCount,
    `expected ${options.messageCount} messages to run, saw ${messageIds.size}`,
  )

  const survivingAttempt = new Map<string, number>()
  for (const execution of executions) {
    const highest = survivingAttempt.get(execution.messageId) ?? 0
    if (execution.attempt > highest) survivingAttempt.set(execution.messageId, execution.attempt)
  }
  const surviving = executions.filter(
    (execution) => survivingAttempt.get(execution.messageId) === execution.attempt,
  )

  for (const [index, execution] of surviving.entries()) {
    for (const other of surviving.slice(index + 1)) {
      assert(
        !overlaps(execution, other),
        `${describe(execution)} and ${describe(other)} overlap, and neither was superseded`,
      )
    }
  }

  const supersededOverlap = executions.some((execution) =>
    executions.some((other) => other !== execution && overlaps(execution, other)),
  )

  return {
    executions: executions.length,
    retried: executions.length > options.messageCount,
    supersededOverlap,
  }
}

function pairExecutions(events: readonly SerializationEvent[]): Execution[] {
  const started = new Map<string, SerializationEvent>()
  const executions: Execution[] = []

  for (const event of [...events].sort((left, right) => left.at - right.at)) {
    const key = `${event.messageId}#${event.attempt}#${event.processId}`
    if (event.event === "start") {
      assert(!started.has(key), `${describe(event)} started twice`)
      started.set(key, event)
      continue
    }
    const start = started.get(key)
    assert(start !== undefined, `${describe(event)} finished with no matching start`)
    started.delete(key)
    executions.push({
      messageId: event.messageId,
      attempt: event.attempt,
      processId: event.processId,
      startedAt: start.at,
      finishedAt: event.at,
    })
  }

  const unfinished = [...started.values()].map(describe)
  assert.equal(unfinished.length, 0, `${unfinished.join(", ")} never wrote a finish`)

  return executions
}

function overlaps(left: Execution, right: Execution): boolean {
  return left.startedAt < right.finishedAt && right.startedAt < left.finishedAt
}

function describe(execution: { messageId: string; attempt: number }): string {
  return `${execution.messageId} attempt ${execution.attempt}`
}

import { describe, expect, it } from "vitest"
import {
  assertSerializedExecution,
  type SerializationEvent,
} from "../examples/failure-recovery/serialization.js"

function execution(options: {
  messageId: string
  attempt: number
  startedAt: number
  finishedAt: number
  processId?: number
}): SerializationEvent[] {
  const { messageId, attempt, startedAt, finishedAt, processId = attempt } = options
  return [
    { event: "start", messageId, attempt, processId, at: startedAt },
    { event: "finish", messageId, attempt, processId, at: finishedAt },
  ]
}

describe("serialization proof", () => {
  it("accepts two executions that do not overlap", () => {
    const events = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      ...execution({ messageId: "b", attempt: 1, startedAt: 30, finishedAt: 40 }),
    ]

    expect(assertSerializedExecution(events, { messageCount: 2 })).toEqual({
      executions: 2,
      retried: false,
      supersededOverlap: false,
    })
  })

  // A worker can lose its lease mid-operation, and the replacement executes the
  // same message again under a higher attempt. That is the at-least-once
  // contract, so the proof counts messages rather than executions.
  it("accepts a message that executes twice after a lost lease", () => {
    const events = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      ...execution({ messageId: "a", attempt: 2, startedAt: 30, finishedAt: 40 }),
      ...execution({ messageId: "b", attempt: 1, startedAt: 50, finishedAt: 60 }),
    ]

    expect(assertSerializedExecution(events, { messageCount: 2 })).toEqual({
      executions: 3,
      retried: true,
      supersededOverlap: false,
    })
  })

  // The attempt that lost the lease is the one that was slow, so it is still
  // running when its replacement starts. Its write is fenced out, and the
  // committed state is what proves that, so the log may interleave here.
  it("accepts a superseded attempt that outlives the start of its replacement", () => {
    const events = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 30 }),
      ...execution({ messageId: "a", attempt: 2, startedAt: 20, finishedAt: 40 }),
      ...execution({ messageId: "b", attempt: 1, startedAt: 50, finishedAt: 60 }),
    ]

    expect(assertSerializedExecution(events, { messageCount: 2 })).toEqual({
      executions: 3,
      retried: true,
      supersededOverlap: true,
    })
  })

  // The superseded attempt finishing late must not be read as its replacement
  // finishing. The replacement is still running, so a second message that
  // starts here is a real serialization failure.
  it("rejects a second message that overlaps a still-running replacement", () => {
    const events = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 35 }),
      ...execution({ messageId: "a", attempt: 2, startedAt: 20, finishedAt: 60 }),
      ...execution({ messageId: "b", attempt: 1, startedAt: 40, finishedAt: 50 }),
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/overlap/)
  })

  it("rejects executions that overlap when no message ran twice", () => {
    const events = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      ...execution({ messageId: "b", attempt: 1, startedAt: 15, finishedAt: 25 }),
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/overlap/)
  })

  it("accepts one execution that ends exactly as the next begins", () => {
    const events = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      ...execution({ messageId: "b", attempt: 1, startedAt: 20, finishedAt: 30 }),
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).not.toThrow()
  })

  it("rejects an execution that never finished", () => {
    const events: SerializationEvent[] = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      { event: "start", messageId: "b", attempt: 1, processId: 1, at: 30 },
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/finish/)
  })

  it("rejects a finish with no start", () => {
    const events: SerializationEvent[] = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      { event: "finish", messageId: "b", attempt: 1, processId: 1, at: 30 },
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/start/)
  })

  it("rejects one attempt that started twice", () => {
    const events: SerializationEvent[] = [
      { event: "start", messageId: "a", attempt: 1, processId: 1, at: 10 },
      { event: "start", messageId: "a", attempt: 1, processId: 1, at: 15 },
      { event: "finish", messageId: "a", attempt: 1, processId: 1, at: 20 },
      { event: "finish", messageId: "a", attempt: 1, processId: 1, at: 25 },
      ...execution({ messageId: "b", attempt: 1, startedAt: 30, finishedAt: 40 }),
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/twice/)
  })

  it("rejects an attempt that starts again after it finished", () => {
    const events: SerializationEvent[] = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      { event: "start", messageId: "a", attempt: 1, processId: 1, at: 25 },
      ...execution({ messageId: "b", attempt: 1, startedAt: 30, finishedAt: 40 }),
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/finish/)
  })

  it("rejects a run that lost one of the messages", () => {
    const events = [
      ...execution({ messageId: "a", attempt: 1, startedAt: 10, finishedAt: 20 }),
      ...execution({ messageId: "a", attempt: 2, startedAt: 30, finishedAt: 40 }),
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/message/)
  })
})

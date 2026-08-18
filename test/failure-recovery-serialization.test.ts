import { describe, expect, it } from "vitest"
import {
  assertSerializedExecution,
  type SerializationEvent,
} from "../examples/failure-recovery/serialization.js"

function execution(messageId: string, startedAt: number, finishedAt: number): SerializationEvent[] {
  return [
    { event: "start", messageId, at: startedAt },
    { event: "finish", messageId, at: finishedAt },
  ]
}

describe("serialization proof", () => {
  it("accepts two executions that do not overlap", () => {
    const events = [...execution("a", 10, 20), ...execution("b", 30, 40)]

    expect(assertSerializedExecution(events, { messageCount: 2 })).toEqual({
      executions: 2,
      retried: false,
      overlapped: false,
    })
  })

  // A worker can lose its lease mid-operation, and the replacement executes the
  // same message again. That is the at-least-once contract, so the proof counts
  // messages rather than executions.
  it("accepts a message that executes twice after a lost lease", () => {
    const events = [...execution("a", 10, 20), ...execution("a", 30, 40), ...execution("b", 50, 60)]

    expect(assertSerializedExecution(events, { messageCount: 2 })).toEqual({
      executions: 3,
      retried: true,
      overlapped: false,
    })
  })

  // The stale attempt is what lost the lease, so it is still running when the
  // replacement starts. Its writes are fenced out, and the committed state is
  // what proves that, so the log is allowed to interleave here.
  it("accepts a stale attempt that is still running when its replacement starts", () => {
    const events: SerializationEvent[] = [
      { event: "start", messageId: "a", at: 10 },
      { event: "start", messageId: "a", at: 20 },
      { event: "finish", messageId: "a", at: 30 },
      { event: "finish", messageId: "a", at: 40 },
      ...execution("b", 50, 60),
    ]

    expect(assertSerializedExecution(events, { messageCount: 2 })).toEqual({
      executions: 3,
      retried: true,
      overlapped: true,
    })
  })

  // A retry excuses the superseded attempt, not the surviving ones. Message a
  // retries, and then the attempt that replaced it runs at the same time as b.
  it("rejects overlap between the surviving attempts even after a retry", () => {
    const events: SerializationEvent[] = [
      ...execution("a", 10, 20),
      { event: "start", messageId: "a", at: 30 },
      { event: "start", messageId: "b", at: 35 },
      { event: "finish", messageId: "a", at: 40 },
      { event: "finish", messageId: "b", at: 45 },
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/overlap/)
  })

  // Without a retry there is no stale owner, so nothing excuses an overlap.
  it("rejects executions that overlap when no message ran twice", () => {
    const events: SerializationEvent[] = [
      { event: "start", messageId: "a", at: 10 },
      { event: "start", messageId: "b", at: 15 },
      { event: "finish", messageId: "a", at: 20 },
      { event: "finish", messageId: "b", at: 25 },
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/overlap/)
  })

  it("rejects an execution that never finished", () => {
    const events = [...execution("a", 10, 20), { event: "start", messageId: "b", at: 30 } as const]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/finish/)
  })

  it("rejects a finish with no start", () => {
    const events: SerializationEvent[] = [
      ...execution("a", 10, 20),
      { event: "finish", messageId: "b", at: 30 },
      ...execution("b", 40, 50),
    ]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/start/)
  })

  it("rejects a run that lost one of the messages", () => {
    const events = [...execution("a", 10, 20), ...execution("a", 30, 40)]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/message/)
  })
})

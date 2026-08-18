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

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).not.toThrow()
  })

  // A worker can lose its lease mid-operation, and the replacement executes the
  // same message again. That is the at-least-once contract, so the proof counts
  // messages rather than executions.
  it("accepts a message that executes twice after a lost lease", () => {
    const events = [...execution("a", 10, 20), ...execution("a", 30, 40), ...execution("b", 50, 60)]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).not.toThrow()
  })

  it("rejects executions that overlap", () => {
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

  it("rejects a run that lost one of the messages", () => {
    const events = [...execution("a", 10, 20), ...execution("a", 30, 40)]

    expect(() => assertSerializedExecution(events, { messageCount: 2 })).toThrow(/message/)
  })
})

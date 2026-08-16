import { describe, expect, it } from "vitest"
import { PollingBackoff } from "../src/polling-backoff.js"

describe("PollingBackoff", () => {
  it("doubles empty-poll intervals until the idle ceiling", () => {
    const backoff = new PollingBackoff({
      minimumIntervalMilliseconds: 25,
      maximumIntervalMilliseconds: 1_000,
    })

    const intervals = [backoff.currentIntervalMilliseconds]
    for (let emptyPolls = 0; emptyPolls < 7; emptyPolls += 1) {
      backoff.recordIdle()
      intervals.push(backoff.currentIntervalMilliseconds)
    }

    expect(intervals).toEqual([25, 50, 100, 200, 400, 800, 1_000, 1_000])
  })

  it("resets to the fast interval after processed work", () => {
    const transitions: Array<{
      previousIntervalMilliseconds: number
      currentIntervalMilliseconds: number
      reason: string
    }> = []
    const backoff = new PollingBackoff({
      minimumIntervalMilliseconds: 25,
      maximumIntervalMilliseconds: 1_000,
      onChange: (transition) => transitions.push(transition),
    })
    backoff.recordIdle()
    backoff.recordIdle()

    backoff.reset("work")

    expect(backoff.currentIntervalMilliseconds).toBe(25)
    expect(transitions.at(-1)).toEqual({
      previousIntervalMilliseconds: 100,
      currentIntervalMilliseconds: 25,
      reason: "work",
    })
  })
})

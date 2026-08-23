import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { ignoreBrokenPipe } from "../src/broken-pipe.js"

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code)
  error.code = code
  return error
}

describe("ignoreBrokenPipe", () => {
  it("reports a broken pipe instead of throwing", () => {
    const stream = new EventEmitter()
    let brokenPipes = 0
    ignoreBrokenPipe(stream, { onBrokenPipe: () => (brokenPipes += 1) })

    expect(() => stream.emit("error", errorWithCode("EPIPE"))).not.toThrow()
    expect(brokenPipes).toBe(1)
  })

  it("leaves every other stream error alone", () => {
    const stream = new EventEmitter()
    let brokenPipes = 0
    ignoreBrokenPipe(stream, { onBrokenPipe: () => (brokenPipes += 1) })

    expect(() => stream.emit("error", errorWithCode("ENOSPC"))).toThrow("ENOSPC")
    expect(brokenPipes).toBe(0)
  })
})

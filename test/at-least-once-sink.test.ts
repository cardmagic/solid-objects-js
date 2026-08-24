import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readSink, recordDelivery } from "../examples/at-least-once/sink.js"

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function sinkPath(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "solid-objects-sink-"))
  return join(directory, "sink.json")
}

describe("at-least-once sink", () => {
  it("records every delivery when deduplication is off", async () => {
    const path = await sinkPath()

    const first = await recordDelivery({
      path,
      effectId: "effect-1",
      attempt: 1,
      deduplicate: false,
    })
    const second = await recordDelivery({
      path,
      effectId: "effect-1",
      attempt: 2,
      deduplicate: false,
    })

    expect(first).toEqual({ applied: true })
    expect(second).toEqual({ applied: true })
    expect((await readSink(path)).deliveries).toEqual([
      { effectId: "effect-1", attempt: 1 },
      { effectId: "effect-1", attempt: 2 },
    ])
  })

  it("applies a replayed effect id once when deduplication is on", async () => {
    const path = await sinkPath()

    const first = await recordDelivery({
      path,
      effectId: "effect-1",
      attempt: 1,
      deduplicate: true,
    })
    const replay = await recordDelivery({
      path,
      effectId: "effect-1",
      attempt: 2,
      deduplicate: true,
    })

    expect(first).toEqual({ applied: true })
    expect(replay).toEqual({ applied: false })
    expect((await readSink(path)).deliveries).toEqual([{ effectId: "effect-1", attempt: 1 }])
  })

  it("reads an empty sink where no file exists", async () => {
    const path = await sinkPath()
    expect(await readSink(path)).toEqual({ deliveries: [] })
  })

  it("refuses to read a damaged sink as an empty one", async () => {
    const path = await sinkPath()
    await writeFile(path, "{ deliveries: ")

    await expect(readSink(path)).rejects.toThrow()
  })

  it("refuses to read an unreadable sink as an empty one", async () => {
    await sinkPath()

    await expect(readSink(directory as string)).rejects.toThrow()
  })
})

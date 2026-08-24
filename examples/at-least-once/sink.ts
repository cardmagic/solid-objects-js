import { readFile, writeFile } from "node:fs/promises"

export interface SinkDelivery {
  effectId: string
  attempt: number
}

export interface SinkState {
  deliveries: SinkDelivery[]
}

export async function readSink(path: string): Promise<SinkState> {
  try {
    const parsed: SinkState = JSON.parse(await readFile(path, "utf-8"))
    return parsed
  } catch {
    return { deliveries: [] }
  }
}

export async function recordDelivery(options: {
  path: string
  effectId: string
  attempt: number
  deduplicate: boolean
}): Promise<{ applied: boolean }> {
  const sink = await readSink(options.path)
  const seen = sink.deliveries.some((delivery) => delivery.effectId === options.effectId)
  if (options.deduplicate && seen) return { applied: false }
  sink.deliveries.push({ effectId: options.effectId, attempt: options.attempt })
  await writeFile(options.path, JSON.stringify(sink, null, 2))
  return { applied: true }
}

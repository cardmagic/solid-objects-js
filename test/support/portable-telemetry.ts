import { readFileSync } from "node:fs"
import { expect } from "vitest"
import type { InstrumentationEvent } from "../../src/configuration.js"

interface PortableEventContract {
  readonly name: string
  readonly match?: Readonly<Record<string, string>>
  readonly attributes: readonly string[]
  readonly javascriptAttributes?: readonly string[]
}

export const telemetryContract: {
  readonly attributes: readonly string[]
  readonly events: readonly PortableEventContract[]
} = JSON.parse(
  readFileSync(new URL("../../compatibility/telemetry-events.json", import.meta.url), "utf8"),
)

export function expectPortableAttributes(event: InstrumentationEvent): void {
  const name = event.name.replace(/^solid_objects\./, "")
  const contract = telemetryContract.events.find(
    (entry) =>
      entry.name === name &&
      Object.entries(entry.match ?? {}).every(([key, value]) => event.attributes[key] === value),
  )

  expect(contract, `${name} has no portable attribute contract`).toBeDefined()
  expect(Object.keys(event.attributes).sort(), `${name} attributes`).toEqual(
    [...(contract?.attributes ?? []), ...(contract?.javascriptAttributes ?? [])].sort(),
  )
}

export function expectPortableEvents(
  events: readonly InstrumentationEvent[],
  names: readonly string[],
): void {
  for (const name of names) {
    const matching = events.filter((event) => event.name === `solid_objects.${name}`)

    expect(matching, `expected a solid_objects.${name} event`).not.toHaveLength(0)
    for (const event of matching) expectPortableAttributes(event)
  }
}

import type { InstrumentationEvent } from "./configuration.js"
import type { JsonObject, JsonValue, Logger } from "./types.js"
import { readonlyCopy } from "./serialization.js"

export interface MetricSample {
  readonly name: string
  readonly kind: "counter" | "gauge" | "histogram"
  readonly unit: "1" | "ms"
  readonly value: number
  readonly labels: Readonly<Record<string, string>>
}

export type EventObserver = (event: InstrumentationEvent) => void

const fields = new Set([
  "failureCount",
  "phase",
  "activationOwnerId",
  "activationGeneration",
  "pollingIntervalMilliseconds",
  "idlePollingIntervalMilliseconds",
  "currentIntervalMilliseconds",
  "component",
  "workers",
  "effectWorkers",
  "broadcastWorkers",
  "reminderSchedulers",
  "actorType",
  "actorId",
  "instanceId",
  "incarnation",
  "revision",
  "messageId",
  "requestId",
  "attempt",
  "sequence",
  "operation",
  "deliveryMode",
  "generation",
  "durationMilliseconds",
  "latenessMilliseconds",
  "ageMilliseconds",
  "depth",
  "count",
  "errorName",
  "outcome",
  "retryable",
  "status",
  "effectId",
  "effectName",
  "reminderId",
  "occurrence",
  "broadcastId",
  "code",
  "role",
  "reason",
  "processId",
  "processKind",
  "ownerId",
  "componentCount",
  "byteCount",
  "thresholdBytes",
  "previousRunAt",
  "nextRunAt",
  "name",
  "commitAction",
  "outboxKind",
  "truncated",
  "payload",
  "waitingOn",
  "timeoutMilliseconds",
  "intervalMilliseconds",
  "previousIntervalMilliseconds",
])

export function telemetryEvent(options: {
  name: string
  adapter: string
  attributes: JsonObject
}): InstrumentationEvent {
  const attributes: JsonObject = {}
  for (const [key, value] of Object.entries(options.attributes)) {
    if (
      fields.has(key) &&
      (value === null || ["string", "number", "boolean"].includes(typeof value))
    ) {
      attributes[key] = value
    }
  }
  const name = `solid_objects.${options.name}`
  const labels = Object.freeze({
    event: name,
    adapter: options.adapter,
    actorType: String(attributes.actorType ?? ""),
  })
  const metrics: MetricSample[] = [
    { name: "solid_objects.events", kind: "counter", unit: "1", value: 1, labels },
  ]
  for (const [field, metric, kind, unit] of [
    ["durationMilliseconds", "solid_objects.duration", "histogram", "ms"],
    ["latenessMilliseconds", "solid_objects.reminder.lateness", "histogram", "ms"],
    ["ageMilliseconds", "solid_objects.outbox.age", "histogram", "ms"],
    ["depth", "solid_objects.mailbox.depth", "gauge", "1"],
  ] as const) {
    const value = attributes[field]
    if (typeof value === "number" && Number.isFinite(value))
      metrics.push({ name: metric, kind, unit, value: Math.max(0, value), labels })
  }
  return Object.freeze({
    schemaVersion: 1,
    name,
    occurredAt: new Date().toISOString(),
    adapter: options.adapter,
    actorType: identifier(attributes.actorType),
    actorId: identifier(attributes.actorId),
    incarnation: identifier(attributes.incarnation ?? attributes.instanceId),
    revision: identifier(attributes.revision),
    messageId: identifier(attributes.messageId),
    attempt: typeof attributes.attempt === "number" ? attributes.attempt : 0,
    attributes: readonlyCopy(attributes),
    metrics: Object.freeze(metrics.map((sample) => Object.freeze(sample))),
  })
}

export function deliverTelemetry(options: {
  observer: EventObserver
  event: InstrumentationEvent
  logger: Logger
}): void {
  const failed = <ErrorValue>(error: ErrorValue) => {
    try {
      const result = options.logger.error({
        event: "solid_objects.instrumentation.failed",
        instrumentationEvent: options.event.name,
        errorName: error instanceof Error ? error.name : "Error",
      })
      void Promise.resolve(result).catch(() => {})
    } catch {}
  }
  try {
    void Promise.resolve(options.observer(options.event)).catch(failed)
  } catch (error) {
    failed(error)
  }
}

function identifier(value: JsonValue | undefined): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null
}

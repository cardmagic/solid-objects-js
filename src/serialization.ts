import { InvalidPayload, PayloadTooLarge } from "./errors.js"
import type { DeepReadonly, JsonValue } from "./types.js"

const MAX_NESTING = 100

export function normalizeJson(value: unknown, options: { maxBytes?: number } = {}): JsonValue {
  const normalized = normalize(value, 0)
  const encoded = JSON.stringify(normalized)

  if (options.maxBytes !== undefined && Buffer.byteLength(encoded) > options.maxBytes) {
    throw new PayloadTooLarge(`serialized value exceeds ${options.maxBytes} bytes`)
  }

  return normalized
}

export function jsonObject(
  value: unknown,
  options: { maxBytes?: number } = {},
): Record<string, JsonValue> {
  const normalized = normalizeJson(value, options)
  if (!isRecord(normalized)) throw new InvalidPayload("value must be a JSON object")

  return normalized
}

export function deepCopy<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(normalizeJson(value))) as Value
}

export function readonlyCopy<Value>(value: Value): DeepReadonly<Value> {
  return deepFreeze(deepCopy(value)) as DeepReadonly<Value>
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(normalizeJson(value)))
}

function normalize(value: unknown, depth: number): JsonValue {
  if (depth > MAX_NESTING) throw new InvalidPayload("serialized value is nested too deeply")
  if (value === null || typeof value === "string" || typeof value === "boolean") return value

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidPayload("non-finite numbers are not supported")
    return value
  }

  if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1))

  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new InvalidPayload(`undefined is not supported at ${key}`)
      output[key] = normalize(item, depth + 1)
    }
    return output
  }

  throw new InvalidPayload(`${describe(value)} is not JSON-compatible`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value === "bigint") return "bigint"
  if (typeof value === "function") return "function"
  if (typeof value === "symbol") return "symbol"
  return value?.constructor?.name ?? typeof value
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key] as JsonValue)]),
  )
}

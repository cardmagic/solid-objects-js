import { createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { EventSeats, type EventCaller } from "./event-seats.js"

const SYSTEM_OPERATIONS = new Set(["confirm", "expire"])

export function authorizeEventMessage({
  actorType,
  operation,
  authorizationContext,
}: {
  actorType: string
  operation: string
  authorizationContext: unknown
}): boolean {
  if (actorType !== EventSeats.actorType) return false
  if (!isEventCaller(authorizationContext)) return false
  if (operation === "setCapacity") return authorizationContext.role === "organizer"
  if (SYSTEM_OPERATIONS.has(operation)) return authorizationContext.role === "system"
  return true
}

export function authorizeEventQuery({
  actorType,
  authorizationContext,
}: {
  actorType: string
  authorizationContext: unknown
}): boolean {
  return actorType === EventSeats.actorType && isEventCaller(authorizationContext)
}

export function eventRuntime({ path }: { path: string }): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path }),
    authorizeMessage: authorizeEventMessage,
    authorizeQuery: authorizeEventQuery,
  })
  runtime.register(EventSeats)
  return runtime
}

function isEventCaller(value: unknown): value is EventCaller {
  if (typeof value !== "object" || value === null) return false
  if (!("userId" in value) || typeof value.userId !== "string") return false
  if (!("role" in value)) return false
  return value.role === "buyer" || value.role === "organizer" || value.role === "system"
}

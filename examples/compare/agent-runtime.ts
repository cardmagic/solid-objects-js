import { createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { AgentSession, type Entry } from "./agent-session.js"

export type ModelClient = {
  reply(options: { idempotencyKey: string; history: Entry[] }): Promise<{ content: string }>
}

const CALLER_OPERATIONS = new Set(["receive", "followUpLater"])

export function agentRuntime({
  path,
  model,
  retryDelayMilliseconds,
}: {
  path: string
  model: ModelClient
  retryDelayMilliseconds?: (attempt: number) => number
}): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path }),
    ...(retryDelayMilliseconds ? { retryDelayMilliseconds } : {}),
    authorizeMessage: ({ actorType, actorId, operation, authorizationContext }) =>
      actorType === AgentSession.actorType &&
      CALLER_OPERATIONS.has(operation) &&
      ownsSession({ actorId, authorizationContext }),
    authorizeQuery: ({ actorType, actorId, authorizationContext }) =>
      actorType === AgentSession.actorType && ownsSession({ actorId, authorizationContext }),
  })
  runtime.register(AgentSession)
  runtime.registerEffect("model_reply", (argumentsValue, context) =>
    model.reply({ idempotencyKey: context.id, history: argumentsValue.history as Entry[] }),
  )
  return runtime
}

function ownsSession({
  actorId,
  authorizationContext,
}: {
  actorId: string
  authorizationContext: unknown
}): boolean {
  if (typeof authorizationContext !== "object" || authorizationContext === null) return false
  return "userId" in authorizationContext && authorizationContext.userId === actorId
}

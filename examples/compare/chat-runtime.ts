import { createRuntime, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"
import { ChatRoom } from "./chat-room.js"

const MEMBER_FIELDS: Record<string, string> = {
  join: "memberId",
  post: "authorId",
  markRead: "memberId",
  pin: "memberId",
}

export function chatRuntime({ path }: { path: string }): SolidObjectsRuntime {
  const runtime = createRuntime({
    database: sqlite({ path }),
    authorizeMessage: ({
      actorType,
      operation,
      arguments: argumentsValue,
      authorizationContext,
    }) => {
      const field = MEMBER_FIELDS[operation]
      if (actorType !== ChatRoom.actorType || !field) return false
      const memberId = memberIdOf(authorizationContext)
      if (memberId === null) return false
      return argumentsValue[field] === memberId
    },
    authorizeQuery: ({ actorType, authorizationContext }) =>
      actorType === ChatRoom.actorType && memberIdOf(authorizationContext) !== null,
  })
  runtime.register(ChatRoom)
  return runtime
}

function memberIdOf(authorizationContext: unknown): string | null {
  if (typeof authorizationContext !== "object" || authorizationContext === null) return null
  if (!("memberId" in authorizationContext)) return null
  return typeof authorizationContext.memberId === "string" ? authorizationContext.memberId : null
}

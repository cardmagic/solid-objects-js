import { randomUUID } from "../platform/uuid.js"
import type { SolidObjectsRuntime } from "../runtime.js"
import type { DeepReadonly, JsonObject, JsonValue } from "../types.js"

const PROTOCOL = "solid-objects-tab-host"
const VERSION = 1
const NAME_PREFIX = "solid-objects:tab-host:"

export interface TabHostRuntimeHandle {
  runtime: SolidObjectsRuntime
  close?: () => Promise<void>
}

export interface TabHostOptions {
  name: string
  startRuntime: () => Promise<TabHostRuntimeHandle>
  onError?: (error: Error) => void
}

export interface TabHost {
  role(): "follower" | "leader"
  leadership(): Promise<void>
  close(): Promise<void>
}

export interface TabInvocation {
  actorType: string
  actorId: string
  operation: string
  arguments?: JsonObject
}

export interface TabClientOptions {
  name: string
  timeoutMilliseconds?: number
  retryIntervalMilliseconds?: number
}

export interface TabClient {
  invoke(invocation: TabInvocation): Promise<DeepReadonly<JsonValue>>
  close(): void
}

export class TabInvocationTimeout extends Error {
  constructor(invocation: TabInvocation) {
    super(
      `no tab host answered ${invocation.actorType}/${invocation.actorId} ` +
        `${invocation.operation} before the timeout`,
    )
    this.name = "TabInvocationTimeout"
  }
}

export class TabInvocationFailed extends Error {
  constructor(details: { name: string; message: string }) {
    super(details.message)
    this.name = details.name
  }
}

interface InvokeRequest {
  protocol: typeof PROTOCOL
  version: typeof VERSION
  kind: "invoke"
  requestId: string
  actorType: string
  actorId: string
  operation: string
  arguments: JsonObject
}

interface InvokeResult {
  protocol: typeof PROTOCOL
  version: typeof VERSION
  kind: "result"
  requestId: string
  outcome:
    | { ok: true; value: DeepReadonly<JsonValue> }
    | { ok: false; error: { name: string; message: string } }
}

interface LeaderAnnouncement {
  protocol: typeof PROTOCOL
  version: typeof VERSION
  kind: "leader-online"
}

type TabMessage = InvokeRequest | InvokeResult | LeaderAnnouncement

export function startTabHost(options: TabHostOptions): TabHost {
  const channelName = `${NAME_PREFIX}${options.name}`
  const queueAbort = new AbortController()
  let currentRole: "follower" | "leader" = "follower"
  let closed = false
  let promoteToLeader = () => {}
  const leadershipPromise = new Promise<void>((resolve) => {
    promoteToLeader = resolve
  })
  let releaseLeadership = () => {}
  const heldLeadership = new Promise<void>((resolve) => {
    releaseLeadership = resolve
  })
  let leaderCleanup: (() => Promise<void>) | undefined

  const lockRequest = requireLocks()
    .request(channelName, { signal: queueAbort.signal }, async () => {
      if (closed) return
      currentRole = "leader"
      promoteToLeader()
      const handle = await options.startRuntime()
      const runAbort = new AbortController()
      const running = handle.runtime.run(runAbort.signal)
      const channel = new BroadcastChannel(channelName)
      channel.onmessage = (event: MessageEvent) => {
        const message = parseTabMessage(event.data)
        if (message) void serveRequest({ handle, channel, message })
      }
      leaderCleanup = async () => {
        channel.onmessage = null
        channel.close()
        runAbort.abort()
        await running.catch(() => undefined)
        await (handle.close?.() ?? handle.runtime.close())
      }
      const announcement: LeaderAnnouncement = {
        protocol: PROTOCOL,
        version: VERSION,
        kind: "leader-online",
      }
      channel.postMessage(announcement)
      if (closed) return
      await heldLeadership
    })
    .catch((error: unknown) => {
      if (queueAbort.signal.aborted) return
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    })

  return {
    role: () => currentRole,
    leadership: () => leadershipPromise,
    close: async () => {
      if (closed) return
      closed = true
      queueAbort.abort()
      releaseLeadership()
      await lockRequest.catch(() => undefined)
      await leaderCleanup?.()
    },
  }
}

export function connectTabClient(options: TabClientOptions): TabClient {
  const channelName = `${NAME_PREFIX}${options.name}`
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000
  const retryIntervalMilliseconds = options.retryIntervalMilliseconds ?? 500
  const channel = new BroadcastChannel(channelName)
  interface PendingInvocation {
    request: InvokeRequest
    resolve: (value: DeepReadonly<JsonValue>) => void
    reject: (error: Error) => void
    retryTimer: ReturnType<typeof setInterval>
    timeoutTimer: ReturnType<typeof setTimeout>
  }
  const pending = new Map<string, PendingInvocation>()

  const settle = (requestId: string, finish: (entry: PendingInvocation) => void) => {
    const entry = pending.get(requestId)
    if (!entry) return
    clearInterval(entry.retryTimer)
    clearTimeout(entry.timeoutTimer)
    pending.delete(requestId)
    finish(entry)
  }

  channel.onmessage = (event: MessageEvent) => {
    const message = parseTabMessage(event.data)
    if (!message) return
    if (message.kind === "leader-online") {
      for (const entry of pending.values()) channel.postMessage(entry.request)
      return
    }
    if (message.kind !== "result") return
    settle(message.requestId, (entry) => {
      if (message.outcome.ok) entry.resolve(message.outcome.value)
      else entry.reject(new TabInvocationFailed(message.outcome.error))
    })
  }

  return {
    invoke: (invocation) =>
      new Promise<DeepReadonly<JsonValue>>((resolve, reject) => {
        const request: InvokeRequest = {
          protocol: PROTOCOL,
          version: VERSION,
          kind: "invoke",
          requestId: randomUUID(),
          actorType: invocation.actorType,
          actorId: invocation.actorId,
          operation: invocation.operation,
          arguments: invocation.arguments ?? {},
        }
        const entry: PendingInvocation = {
          request,
          resolve,
          reject,
          retryTimer: setInterval(() => channel.postMessage(request), retryIntervalMilliseconds),
          timeoutTimer: setTimeout(
            () =>
              settle(request.requestId, (held) =>
                held.reject(new TabInvocationTimeout(invocation)),
              ),
            timeoutMilliseconds,
          ),
        }
        pending.set(request.requestId, entry)
        channel.postMessage(request)
      }),
    close: () => {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, (entry) => entry.reject(new Error("tab client closed")))
      }
      channel.onmessage = null
      channel.close()
    },
  }
}

async function serveRequest(input: {
  handle: TabHostRuntimeHandle
  channel: BroadcastChannel
  message: TabMessage
}): Promise<void> {
  const { handle, channel, message } = input
  if (message.kind !== "invoke") return
  const request = message
  let outcome: InvokeResult["outcome"]
  try {
    const enqueued = await handle.runtime.enqueueInternalMessage<JsonValue>({
      actorType: request.actorType,
      actorId: request.actorId,
      operation: request.operation,
      argumentsValue: request.arguments,
      idempotencyKey: `tab:${request.requestId}`,
    })
    outcome = { ok: true, value: await enqueued.wait() }
  } catch (error) {
    outcome = {
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  const result: InvokeResult = {
    protocol: PROTOCOL,
    version: VERSION,
    kind: "result",
    requestId: request.requestId,
    outcome,
  }
  channel.postMessage(result)
}

function parseTabMessage(value: unknown): TabMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Partial<TabMessage>
  if (candidate.protocol !== PROTOCOL || candidate.version !== VERSION) return undefined
  if (
    candidate.kind === "invoke" ||
    candidate.kind === "result" ||
    candidate.kind === "leader-online"
  ) {
    return candidate as TabMessage
  }
  return undefined
}

function requireLocks(): LockManager {
  const locks = globalThis.navigator?.locks
  if (!locks) {
    throw new Error("the Web Locks API is unavailable; the tab host cannot elect a leader")
  }
  return locks
}

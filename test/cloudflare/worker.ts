import { Actor, broadcastValue, NonRetryableError } from "../../src/core.js"
import { PortableCounter } from "../support/portable-actor.js"
import {
  createDurableObjectsHost,
  createDurableObjectsSessionHost,
  durableObjects,
} from "../../src/cloudflare/index.js"

export const gates = new Map<string, () => void>()
export const revokedSessions = new Set<string>()
export const deliveries = new Map<string, number>()
const droppedAcknowledgements = new Set<string>()

export class Counter extends Actor {
  static override readonly actorType = "Counter"
  count = 0
  echo(options: { value: string }): string {
    this.count += 1
    return options.value
  }
  static override readonly payloads = {
    personal: (actor: Counter, authorization: unknown) => ({ count: actor.count, authorization }),
    broken: () => {
      throw new Error("projection unavailable")
    },
    denied: () => ({ private: true }),
  }

  increment(options: { amount?: number } = {}): number {
    this.count += options.amount ?? 1
    return this.count
  }

  async incrementAfterAwait(): Promise<number> {
    const before = this.count
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    this.count = before + 1
    return this.count
  }

  get doubled(): number {
    return this.count * 2
  }

  retry(): number {
    if (this.currentMessage!.attempt < 2) {
      this.count = 100
      throw new Error("retry once")
    }
    return this.increment()
  }

  rejectChange(): void {
    this.count = 100
    this.reject("unavailable", { message: "try something else" })
  }

  arm(options: { at: number }): void {
    this.schedule({ at: new Date(options.at) }).increment!()
  }

  forward(options: { target: string }): void {
    this.sendTo(Counter.ref(options.target)).increment()
  }

  async forwardAfterAwait(options: { target: string }): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    this.sendTo(Counter.ref(options.target)).increment()
  }

  async forbiddenCall(): Promise<void> {
    await Counter.ref("forbidden").increment()
  }

  async pause(): Promise<void> {
    this.count = 100
    await waitForGate(this.actorId)
    this.count = 200
  }

  slowEffect(): void {
    this.emit("slow", { onSuccess: "effectDone" })
  }
  repeatedEffect(): void {
    this.emit("repeat", { onSuccess: "effectDone" })
  }

  failWithIntents(): void {
    this.count = 100
    this.emit("increment")
    this.sendTo(Counter.ref("should-not-receive")).increment()
    this.schedule({ at: new Date(0) }).increment!()
    throw new NonRetryableError("rollback staged work")
  }

  failPermanently(): void {
    this.count = 100
    throw new NonRetryableError("permanent failure")
  }

  commitToDatabase(): void {
    this.count = 100
    this.commitAction("database-write")
  }

  armRecurring(options: { at: number; interval: number; missed: "all" | "latest" }): void {
    this.schedule({
      at: new Date(options.at),
      everyMilliseconds: options.interval,
      missed: options.missed,
    }).increment!()
  }

  effect(): void {
    this.emit("increment", { onSuccess: "effectDone" })
  }
  effectDone(): void {
    this.count += 10
  }

  override observables() {
    return { count: broadcastValue(this.count) }
  }
}

export class VersionedCounter extends Actor {
  static override readonly actorType = "VersionedCounter"
  static override readonly stateVersion = 2
  static override readonly migrations = [
    {
      from: 1,
      to: 2,
      migrate: (state: { [key: string]: import("../../src/core.js").JsonValue }) => ({
        count: Number(state.count) + 10,
      }),
    },
  ]
  count = 0
  increment(): number {
    this.count += 1
    return this.count
  }
}

export class Actors extends createDurableObjectsHost<Env>({
  actors: [Counter, PortableCounter, VersionedCounter],
  configure: (environment) => ({
    backend: durableObjects({
      namespace: {
        getByName: (name) => ({
          request: async (request) => {
            const reply = await environment.ACTORS.getByName(name).request(request)
            if (
              request.method === "internal" &&
              request.actorId === "lost-ack" &&
              !droppedAcknowledgements.has(String(request.payload.requestId))
            ) {
              droppedAcknowledgements.add(String(request.payload.requestId))
              throw new Error("acknowledgement lost")
            }
            return reply
          },
        }),
      },
      sessions: environment.SESSIONS,
    }),
    authorizeMessage: (input) => input.authorizationContext === "allowed",
    authorizeQuery: (input) =>
      input.authorizationContext === "allowed" && input.operation !== "denied",
    authorizeDestroy: (input) => input.authorizationContext === "allowed",
    authorizeSubscription: (input) => input.authorizationContext === "allowed",
    authorizeAdministration: (input) => input.authorizationContext === "allowed",
    retryDelayMilliseconds: () => 10,
    effects: {
      increment: () => ({ accepted: true }),
      slow: async (_arguments, context) => {
        await waitForGate(context.actorId)
      },
      repeat: (_arguments, context) => {
        const attempts = (deliveries.get(context.id) ?? 0) + 1
        deliveries.set(context.id, attempts)
        if (attempts === 1) throw new Error("effect acknowledgement lost")
        return { accepted: true }
      },
    },
  }),
}) {}

export class Sessions extends createDurableObjectsSessionHost<Env>({
  backend: (environment) =>
    durableObjects({ namespace: environment.ACTORS, sessions: environment.SESSIONS }),
  resolveAuthorizationContext: ({ sessionId }) =>
    sessionId === "test-session" && !revokedSessions.has(sessionId) ? "allowed" : null,
}) {}

export default { fetch: () => new Response("Solid Objects tests") }

function waitForGate(actorId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3_000)
    gates.set(actorId, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

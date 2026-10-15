# Restate virtual objects and Solid Objects: state and delayed calls for each key in TypeScript

Restate is a durable execution runtime. A Restate virtual object keeps state for each key, runs one write handler at a time for each key, and records each step in a journal on the Restate server. Solid Objects (the `solid-objects` npm package) gives each key an actor with an ordered mailbox, durable state, and reminders, stored in the SQLite, PostgreSQL, or MySQL database that the app already uses. It needs no separate server. Choose Restate when you want a journal of every step and you can run the Restate server or use Restate Cloud. Choose Solid Objects when you want the state and the order in your own SQL database, with no new server to operate.

Solid Objects is an independent project. It is not affiliated with Restate.

## The short answer

| Question              | Restate virtual object                                                                                   | Solid Objects                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| What has state        | An object name and a key                                                                                 | An actor class and an actor ID                                                                            |
| One writer at a time  | "At most one handler with write access can run at a time per object key"                                 | One turn at a time for each actor                                                                         |
| Order                 | "Calls to a Virtual Object execute in order of arrival, serially"                                        | Messages run in the order that the runtime stores them                                                    |
| Where the state lives | The embedded key-value store of the Restate server                                                       | Tables in your SQL database                                                                               |
| Delayed call          | `ctx.objectSendClient(...).handler(input, restate.rpc.sendOpts({ delay }))`                              | `this.schedule({ at, key }).operation(input)`                                                             |
| Side effects          | `ctx.run` stores the result in the journal. After the result commits, the step does not run again        | `emit` stages an effect with a stable ID. The effect runs at least once, and a callback updates the state |
| What you run          | The Restate server (one binary or a cluster) and your service                                            | Your Node.js process, which calls `runtime.run(signal)`                                                   |
| Node.js               | Node.js 22 or newer for the SDK                                                                          | Node.js 24.4 or newer                                                                                     |
| Licence               | SDK: MIT. Server: Business Source License 1.1, which changes to Apache 2.0 four years after each release | MIT. The optional Solid Objects Pro package is commercial                                                 |

The Restate facts come from the [Restate documentation](https://docs.restate.dev) and the [Restate server licence](https://github.com/restatedev/restate/blob/main/LICENSE) (checked October 15, 2026).

## Choose Restate when

- You want a journal of each step, so that a retry resumes after the last completed step.
- You can run the Restate server, or you can use Restate Cloud.
- You want workflows, service calls, and virtual objects in one runtime.
- You use an agent framework that Restate integrates with in TypeScript, such as the Vercel AI SDK.

## Choose Solid Objects when

- You want the state and the mailbox in the SQL database that you already operate, back up, and query.
- You do not want to run another server.
- You want a state change and its effects, reminders, and broadcasts to commit in one SQL transaction.
- You also have a Rails app. The `solid_objects` gem has the same model.

## The same terms in each

| Restate                                   | Solid Objects                                        |
| ----------------------------------------- | ---------------------------------------------------- |
| Virtual object key                        | Actor ID                                             |
| Exclusive handler (`ObjectContext`)       | Actor method (an operation)                          |
| Shared handler                            | Query (a getter) or `snapshot()`                     |
| `ctx.get` and `ctx.set`                   | Actor fields                                         |
| Delayed call with `sendOpts({ delay })`   | `schedule({ at, key })` and an operation             |
| `ctx.cancel(invocationId)`                | [Cancel a reminder](../api.md#cancelling-a-reminder) |
| `ctx.run`                                 | `emit` and an effect handler                         |
| `ctx.rand.uuidv4()` as an idempotency key | The effect ID, `context.id`                          |
| `restate deployments register`            | `runtime.register(ActorClass)`                       |

## An AI agent session in each

The task: a Node.js TypeScript backend runs a long-lived AI agent session for each user. A session holds conversation state. It receives user messages and tool results that must apply in order. It can schedule its own follow-up, for example "check the order status again in 2 hours". Sessions must survive deploys and process crashes. The app uses PostgreSQL and runs several Node.js processes.

### With Restate

This code follows the Restate documentation and type-checks against `@restatedev/restate-sdk` 1.17.3. It was not run against a Restate server.

```typescript
import * as restate from "@restatedev/restate-sdk"

type Message = { role: "user" | "assistant" | "tool"; content: string }
type LlmReply = { text: string; followUpOrderId?: string }

declare function callLlm(messages: Message[]): Promise<LlmReply>
declare function fetchOrderStatus(orderId: string): Promise<string>

async function appendAndAsk(ctx: restate.ObjectContext, message: Message) {
  const messages = (await ctx.get<Message[]>("messages")) ?? []
  messages.push(message)
  const reply = await ctx.run("LLM call", () => callLlm(messages))
  messages.push({ role: "assistant", content: reply.text })
  ctx.set("messages", messages)
  return reply
}

export const agentSession = restate.object({
  name: "AgentSession",
  handlers: {
    message: async (ctx: restate.ObjectContext, message: Message) => {
      const reply = await appendAndAsk(ctx, message)
      if (!reply.followUpOrderId) return reply.text
      ctx
        .objectSendClient(agentSession, ctx.key)
        .checkOrder(reply.followUpOrderId, restate.rpc.sendOpts({ delay: { hours: 2 } }))
      return reply.text
    },
    checkOrder: async (ctx: restate.ObjectContext, orderId: string) => {
      const status = await ctx.run("order status", () => fetchOrderStatus(orderId))
      await appendAndAsk(ctx, { role: "tool", content: `Order ${orderId}: ${status}` })
    },
  },
})

restate.serve({ services: [agentSession], port: 9080 })
```

What this code gets from Restate:

- Calls for one session run one at a time, in order of arrival.
- The model reply is in the journal. Restate says that model calls are "Persisted so responses are not re-fetched on recovery".
- The delayed call to `checkOrder` is durable.

What to know:

- As in the Restate session examples, the model call runs inside the exclusive handler. A new message for the same session waits until the model call and the handler finish.
- The Restate pages differ on side effects. The agent page says "Side effects are executed exactly once". The saga guide tells you to register compensation "in case action succeeded but confirmation was lost", so a `ctx.run` action can run again.
- For long model calls, Restate tells you to raise the inactivity timeout (default 1 minute) and the abort timeout (default 10 minutes).
- The state is a key-value store inside the Restate server. Restate says "SQL is supported only for analytics / introspection".

### With Solid Objects

There is one `AgentSession` actor for each user ID.

```typescript
import { Actor, type EffectSuccessPayload } from "solid-objects"

export const FOLLOW_UP_MILLISECONDS = 2 * 60 * 60 * 1000

const KEPT_ENTRIES = 50

export type Entry = { role: "user" | "tool" | "assistant"; content: string }

type ReplyArguments = { turn: number; history: Entry[] }
type ReplyResult = { content: string }

export class AgentSession extends Actor {
  static override readonly actorType = "AgentSession"

  history: Entry[] = []
  turn = 0
  followUps: string[] = []

  receive({ role, content }: { role: "user" | "tool"; content: string }): { turn: number } {
    this.#append({ role, content })
    return { turn: this.turn }
  }

  followUpLater({ topic }: { topic: string }): void {
    this.schedule({ at: new Date(Date.now() + FOLLOW_UP_MILLISECONDS), key: topic }).followUp({
      topic,
    })
  }

  followUp({ topic }: { topic: string }): void {
    this.followUps = [...this.followUps, topic]
    this.#append({ role: "tool", content: `Follow-up due: ${topic}` })
  }

  replied({ arguments: reply, result }: EffectSuccessPayload<ReplyArguments, ReplyResult>): void {
    if (reply.turn !== this.turn) return
    this.history = [...this.history, { role: "assistant" as const, content: result.content }].slice(
      -KEPT_ENTRIES,
    )
  }

  #append(entry: Entry): void {
    this.history = [...this.history, entry].slice(-KEPT_ENTRIES)
    this.turn += 1
    this.emit("model_reply", {
      arguments: { turn: this.turn, history: this.history },
      onSuccess: "replied",
    })
  }
}
```

The runtime registers the actor and the effect that calls the model:

```typescript
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
```

The app sends each message with `send`, so that the message is stored before the call returns:

```typescript
await runtime
  .ref(AgentSession, user.id)
  .send.with({ authorizationContext: { userId: user.id }, idempotencyKey: message.id })
  .receive({ role: "user", content: message.text })
```

At least one process calls `runtime.run(signal)`. It runs the stored messages, the effects, and the reminders.

How it works:

- Messages for one session run one at a time, in the order that the runtime stores them.
- `receive` appends the entry, moves `turn` forward, and stages a `model_reply` effect. The turn ends at once. The model call runs outside the turn, so a new message does not wait for it.
- The effect handler uses `context.id` as the idempotency key. If the effect fails, the runtime retries it with the same ID, up to `maxAttempts` (5 by default). `AgentSession` has no `onFailure` callback, so if every attempt fails, that turn gets no reply.
- `replied` adds the model reply only if no newer message arrived. A reply for an older turn is dropped, because the newer turn has its own reply.
- `followUpLater` schedules a keyed reminder. The reminder is a row in the database, so it runs after a deploy or a restart. One key holds one alarm, so a second call with the same topic moves the alarm.
- The policy lets each user call only their own session, and only `receive` and `followUpLater`. Callbacks and reminders do not go through the caller policy.

A model call can run again after a crash, because effects run at least once. If the model API does not accept an idempotency key, the repeated call can cost tokens again. A step in Restate or DBOS that crashes before its result is recorded runs again too.

### What the tests prove

[The tests](../../test/compare-agent-session.test.ts) show these results:

- Two user messages and a tool result apply in the order that they were sent.
- A model call that fails and runs again uses the same idempotency key, and the session keeps one reply.
- When two messages arrive before the model replies, the session keeps only the reply for the newest turn.
- A follow-up runs after a runtime restart.
- A caller who does not own the session gets `Unauthorized`.

## Questions that teams ask

**Is Solid Objects mature enough?** Here are the facts:

- First public release of the npm package: August 13, 2026.
- Version 1.0.0: October 13, 2026. The public API follows [semantic versioning](../versioning.md).
- One maintainer.
- One first-party application with more than 100,000 users runs it in production. That is a count of users, not a measure of load. No production use by other people is known.
- The [benchmarks](../benchmarks.md) are development measurements. Longer soak tests are open work.

Restate reached 1.0 in June 2024. If a longer history matters more than keeping the state in your own database, choose Restate.

**Why Node.js 24.4 or newer?** The SQLite adapter reads integer columns as `BigInt`. Node.js 24.4.0 is the first release that accepts `readBigInts` on the built-in SQLite module. See [support](../support.md).

**Does it need another process?** No new server. A process of your app calls `runtime.run(signal)`. It can be the web process or a separate worker. While no process runs, pending work stays in SQL.

**Is delivery exactly once?** No. Delivery is at least once. Use the effect ID as the idempotency key for each external call. See [correctness](../correctness.md) and [effect recovery](../effect-recovery.md).

**What if one session is very busy?** One actor runs one turn at a time. The turns are short, because the model call runs as an effect outside the turn.

## Sources

Checked October 15, 2026:

- [Restate services and virtual objects](https://docs.restate.dev/foundations/services)
- [Restate service communication and delayed calls](https://docs.restate.dev/develop/ts/service-communication)
- [Restate durable steps](https://docs.restate.dev/develop/ts/durable-steps)
- [Restate durable agents](https://docs.restate.dev/ai/patterns/durable-agents)
- [Restate agent sessions](https://docs.restate.dev/ai/patterns/sessions)
- [Restate sagas](https://docs.restate.dev/guides/sagas)
- [Restate service configuration](https://docs.restate.dev/services/configuration)
- [Restate server overview](https://docs.restate.dev/server/overview)
- [Restate server licence](https://github.com/restatedev/restate/blob/main/LICENSE)

## More information

- [All comparisons](../comparisons.md)
- [DBOS Transact and Solid Objects](dbos.md)
- [Virtual actors in TypeScript](../virtual-actors.md)
- [Guide for coding agents](../agents.md)

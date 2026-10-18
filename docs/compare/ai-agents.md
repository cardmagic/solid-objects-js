# Durable execution for TypeScript AI agents on PostgreSQL: Restate, DBOS, Temporal, and Solid Objects

A long-lived AI agent session must keep its conversation state, apply messages in order, and wake up later for a follow-up, after deploys and crashes. Restate, DBOS Transact, and Temporal do this with durable execution: each tool records the steps of a handler or workflow and resumes after a crash. Solid Objects (the `solid-objects` npm package) does it with an actor for each session: an ordered mailbox, durable state, and reminders in the SQLite, PostgreSQL, or MySQL database that the app already uses. Only DBOS and Solid Objects write their state from your app process to a PostgreSQL database. Restate keeps it in the Restate server. Temporal keeps it in the Temporal Service, which can use PostgreSQL as its own store.

Solid Objects is an independent project. It is not affiliated with Restate, DBOS, or Temporal Technologies.

## The short answer

| Tool          | Where the state lives                                                                                                                               | What a crash repeats                                                                                                                                  | How a delayed follow-up works                                                                                  | What you run                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Restate       | A journal and a key-value store inside the Restate server, not in PostgreSQL                                                                        | "Restate replays the journal, skipping completed steps". A `ctx.run` action that did not record its result can run again                              | A delayed message: `ctx.objectSendClient(...).handler(input, restate.rpc.sendOpts({ delay }))`, or `ctx.sleep` | Restate Cloud, Restate BYOC, or a self-hosted Restate server (a single binary with a persistent volume), and your service                |
| DBOS Transact | Checkpoints in a PostgreSQL system database. DBOS recommends "storing long-lived objects directly in your database"                                 | "Steps are tried _at least once_ but are never re-executed after they complete"                                                                       | Durable sleep with `DBOS.sleep(milliseconds)` in a workflow, or `delaySeconds` when you enqueue                | The library in your Node.js processes and PostgreSQL. The docs say that distributed applications "should also connect to DBOS Conductor" |
| Temporal      | The event history of each workflow, in the Temporal Service. The service stores it in Cassandra, MySQL, or PostgreSQL (SQLite for development only) | Workflow code replays its event history. "completed Activities will not re-execute", but an activity that did not report its result "will be retried" | A durable timer: `sleep('2 hours')` from `@temporalio/workflow`, or `condition` with a timeout                 | A Temporal Service (the Temporal Server and a database) or Temporal Cloud, and your worker processes                                     |
| Solid Objects | Actor state, the mailbox, and reminders in tables in your SQL database                                                                              | A turn that did not commit runs again. Effects run at least once with a stable effect ID                                                              | A reminder: `this.schedule({ at, key }).followUp(input)`, stored as a row                                      | Your Node.js process, which calls `runtime.run(signal)`, and your database                                                               |

The facts come from the [Restate documentation](https://docs.restate.dev), the [DBOS documentation](https://docs.dbos.dev), and the [Temporal documentation](https://docs.temporal.io) (checked October 18, 2026).

## Messages in order for one session

- Restate: a virtual object for each session. "Only one write handler runs at a time per key", and "concurrent requests to the same session are automatically queued".
- DBOS Transact: a workflow for each session that waits with `DBOS.recv`. "Messages are dequeued first-in, first-out from a queue associated with the topic." A partitioned queue with `queuePartitionKey` and `partitionConcurrency: 1` also runs one workflow at a time for each key.
- Temporal: a long-lived workflow for each session that gets Signals or Updates. Temporal processes messages "in the order they were received". Handlers that wait "can run interleaved with the main Workflow and with one another".
- Solid Objects: an actor for each session. Messages run one turn at a time, in the order that the runtime stores them.

## Where the model call runs

- Restate: in a `ctx.run` step inside the handler. Restate says that model calls are "Persisted so responses are not re-fetched on recovery". In an exclusive handler, a new message for the same session waits until the handler finishes.
- DBOS Transact: in a step of the workflow. After the step completes, DBOS does not run it again.
- Temporal: in an activity. The Temporal integration with the OpenAI Agents SDK for TypeScript is marked "Pre-release". It says that "model calls are executed as Activities, so they retry durably and are not repeated during Workflow replay".
- Solid Objects: in an effect, outside the turn. The turn ends at once, so a new message does not wait for the model. The effect handler sends the effect ID as the idempotency key.

## Choose Restate when

- You want a journal of each step, and you can run the Restate server or use Restate Cloud.
- You want workflows, service calls, and virtual objects in one runtime.

See [Restate virtual objects and Solid Objects](restate.md) for the same agent session in each, with code.

## Choose DBOS Transact when

- The agent is a workflow of steps, and a completed step must not run again after a crash.
- You want the checkpoints in PostgreSQL, with no separate orchestration server.

See [DBOS Transact and Solid Objects](dbos.md) for the details.

## Choose Temporal when

- The agent is a long workflow of many steps, and you want its event history and replay.
- You already run a Temporal Service, or you can use Temporal Cloud.
- A session can stay inside the history limit: "51,200 Events or 50 MB". A longer session continues as new with a new history.

## Choose Solid Objects when

- Each session has state that many messages change in order, and the session must wake up later.
- You want the session state in the SQL database that you already operate, back up, and query.
- You want a state change and its effects and reminders to commit in one SQL transaction.
- You do not want to run another server.

## An AI agent session with Solid Objects

The task: a Node.js TypeScript backend runs a long-lived AI agent session for each user. A session holds conversation state. It receives user messages and tool results that must apply in order. It can schedule its own follow-up, for example "check the order status again in 2 hours". Sessions must survive deploys and process crashes. The app uses PostgreSQL and runs several Node.js processes.

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

The example uses SQLite so that the tests run without a database server. For PostgreSQL, import `postgresql` from `solid-objects/database/postgresql` and pass `postgresql({ connectionString })` as `database`.

The app sends each message with `send`, so that the message is stored before the call returns:

```typescript
await runtime
  .ref(AgentSession, user.id)
  .send.with({ authorizationContext: { userId: user.id }, idempotencyKey: message.id })
  .receive({ role: "user", content: message.text })
```

At least one process calls `runtime.run(signal)`. It runs the stored messages, the effects, and the reminders.

How it works:

- `receive` appends the entry, moves `turn` forward, and stages a `model_reply` effect. The model call runs outside the turn.
- If the effect fails, the runtime retries it with the same ID, up to `maxAttempts` (5 by default).
- `replied` adds the model reply only if no newer message or follow-up arrived.
- `followUpLater` schedules a keyed reminder. The reminder is a row in the database, so it runs after a deploy or a restart.

A model call can run again after a crash, because effects run at least once. If the model API does not accept an idempotency key, the repeated call can cost tokens again. A step in Restate, DBOS, or Temporal that crashes before its result is recorded runs again too.

### What the tests prove

[The tests](../../test/compare-agent-session.test.ts) show these results:

- Two user messages and a tool result apply in the order that they were sent.
- A model call that fails and runs again uses the same idempotency key, and the session keeps one reply.
- When two messages arrive before the model replies, the session keeps only the reply for the newest turn.
- A follow-up runs after a runtime restart.
- A caller who does not own the session gets `Unauthorized`.

## Questions that teams ask

**Which of these keep state in my PostgreSQL database?** DBOS Transact keeps its checkpoints in a PostgreSQL system database. Solid Objects keeps actor state in your SQLite, PostgreSQL, or MySQL database. Restate keeps state in its own server. For that state, Restate says "SQL is supported only for analytics / introspection, not for updates/transactions". Temporal keeps the event history in the Temporal Service, which can use PostgreSQL as its own store.

**Is Solid Objects mature enough?** Here are the facts:

- First public release of the npm package: August 13, 2026.
- Version 1.0.0: October 13, 2026. The public API follows [semantic versioning](../versioning.md).
- [Maintenance and continuity](../maintenance.md) tells you who maintains the project and how a release is made.
- One first-party application with more than 100,000 users runs it in production. That is a count of users, not a measure of load. No production use by other people is known.
- The [benchmarks](../benchmarks.md) are development measurements. Longer soak tests are open work.

The npm packages of Temporal, Restate, and DBOS were first published between 2021 and 2023 ([npm registry](https://www.npmjs.com), checked October 18, 2026). If a longer history matters more than keeping the session state in your own database, choose one of them.

**Is delivery exactly once?** No. In Solid Objects, delivery is at least once. Use the effect ID as the idempotency key for each external call. See [correctness](../correctness.md) and [effect recovery](../effect-recovery.md).

**Can I use more than one?** Yes. For example, keep each session in a Solid Objects actor, and run a long multi-step task as a workflow in DBOS or Temporal.

## Sources

Checked October 18, 2026:

- [Restate key concepts](https://docs.restate.dev/foundations/key-concepts)
- [Restate durable sessions](https://docs.restate.dev/ai/patterns/sessions)
- [Restate durable agents](https://docs.restate.dev/ai/patterns/durable-agents)
- [Restate scheduling and timers](https://docs.restate.dev/develop/ts/durable-timers)
- [Restate service communication](https://docs.restate.dev/develop/ts/service-communication)
- [Restate hosting overview](https://docs.restate.dev/hosting/overview)
- [Restate server overview](https://docs.restate.dev/server/overview)
- [Restate databases guide](https://docs.restate.dev/guides/databases)
- [DBOS architecture](https://docs.dbos.dev/architecture)
- [Migrating from Temporal to DBOS](https://docs.dbos.dev/explanations/migrating-from-temporal)
- [DBOS workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)
- [DBOS workflow communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication)
- [DBOS methods reference](https://docs.dbos.dev/typescript/reference/methods)
- [DBOS queue tutorial](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)
- [Temporal workflow execution](https://docs.temporal.io/workflow-execution)
- [Temporal event history](https://docs.temporal.io/workflow-execution/event)
- [Temporal activity definition](https://docs.temporal.io/activity-definition)
- [Temporal TypeScript timers](https://docs.temporal.io/develop/typescript/workflows/timers)
- [Temporal message handling](https://docs.temporal.io/handling-messages)
- [Temporal workflow execution limits](https://docs.temporal.io/workflow-execution/limits)
- [Temporal Service persistence](https://docs.temporal.io/temporal-service/persistence)
- [Temporal workers](https://docs.temporal.io/workers)
- [Temporal and the OpenAI Agents SDK for TypeScript](https://docs.temporal.io/develop/typescript/integrations/openai-agents)

## More information

- [All comparisons](../comparisons.md)
- [Restate virtual objects and Solid Objects](restate.md)
- [DBOS Transact and Solid Objects](dbos.md)
- [Virtual actors in TypeScript](../virtual-actors.md)
- [Guide for coding agents](../agents.md)

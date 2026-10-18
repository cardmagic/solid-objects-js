# RivetKit actors and Solid Objects: chat rooms with ordered state on PostgreSQL in Node.js

RivetKit is the TypeScript SDK for Rivet Actors: long-lived processes with durable state, queues, realtime connections, and scheduling. A Rivet control plane schedules the actors and stores their state. Solid Objects (the `solid-objects` npm package) gives each key an actor with an ordered mailbox, durable state, and reminders, in the SQLite, PostgreSQL, or MySQL database that the app already uses. It has no control plane. Choose RivetKit when you want built-in WebSocket connections, many actors that keep state in memory, and a platform that runs them for you. Choose Solid Objects when each change must commit to your own SQL database with its follow-up work, in order, without a new service to operate.

Solid Objects is an independent project. It is not affiliated with Rivet.

## The short answer

| Question                | RivetKit                                                                                                                                                                                             | Solid Objects                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| What has state          | An actor and its key                                                                                                                                                                                 | An actor class and an actor ID                                                                  |
| One at a time           | "By default, actions run in parallel. If you need advanced control over concurrency, use queues"                                                                                                     | One turn at a time for each actor                                                               |
| When the state is saved | "Rapid mutations are batched into a single write on a throttle (`stateSaveInterval`, default 1 second)… saves aren't tied to action or handler boundaries"                                           | Each turn commits the state, effects, and reminders in one SQL transaction                      |
| A failed queue message  | "If processing fails before `message.complete()`, the message is not redelivered"                                                                                                                    | The message runs again. It holds back later messages until it succeeds or becomes a dead letter |
| Later work              | `c.schedule.after` and `c.schedule.at`. "Schedules survive actor sleep, restarts, upgrades, and crashes"                                                                                             | `this.schedule({ at, key }).operation(input)`                                                   |
| Realtime                | Events over WebSockets with `c.broadcast`                                                                                                                                                            | Committed broadcasts. Your app owns the WebSocket transport                                     |
| What you run            | Your workers and a Rivet control plane. Rivet Cloud or BYOC can run it for you. Self-hosted, it is a Rust binary with RocksDB, PostgreSQL, or FoundationDB storage, plus NATS for more than one node | Your Node.js process and your database                                                          |
| PostgreSQL              | A control plane storage backend, "production-ready for light-to-moderate workloads, up to roughly 1,000 concurrent actors"                                                                           | The application database, with your own tables beside it                                        |
| Node.js                 | Node.js 22 or newer                                                                                                                                                                                  | Node.js 24.4 or newer                                                                           |
| Licence                 | Apache-2.0. The FoundationDB storage backend "requires an enterprise license"                                                                                                                        | MIT. The optional Solid Objects Pro package is commercial                                       |

The RivetKit facts come from the [Rivet documentation](https://rivet.dev/docs/) (checked October 15, 2026).

## Choose RivetKit when

- You want realtime WebSocket connections to each actor, built in.
- You want state in memory with fast access, and a throttled save is acceptable.
- You want a per-actor SQLite database, or you want Rivet to run the actors for you.
- You expect very many active actors and can use the storage backend that suits that scale.

## Choose Solid Objects when

- Each change must be saved before the call returns, together with its effects and reminders.
- Changes to one key must apply in order without a separate queue loop.
- A failed change must hold its place and run again.
- You do not want to depend on a control plane, self-hosted or on Rivet Cloud.
- You want the state in the SQL database that you already back up and query.

## The same terms in each

| RivetKit                             | Solid Objects                            |
| ------------------------------------ | ---------------------------------------- |
| `actor({ ... })` and its key         | An `Actor` class and an actor ID         |
| An action                            | An actor method (an operation)           |
| A queue and a `run` loop             | The actor mailbox                        |
| `c.state`                            | Actor fields                             |
| `c.schedule.after`                   | `schedule({ at, key })` and an operation |
| `c.broadcast`                        | `observables()` and the realtime layer   |
| `client.chatRoom.getOrCreate([key])` | `runtime.ref(ChatRoom, id)`              |

## A chat room in each

The task: chat rooms in a Node.js TypeScript server with PostgreSQL. Several Node.js processes run. Messages in one room must get a strict order. Room state (members, unread counts, pinned message) must survive restarts. A room archives itself after 7 days with no activity. Rooms are independent of each other.

### With RivetKit

This code follows the Rivet documentation. It was not compiled or run. The docs show `c.saveState` in actions but not inside `run`, and they do not give the type of the schedule ID.

```typescript
import { actor, event, queue, setup } from "rivetkit"

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
type Message = { seq: number; from: string; text: string; at: number }

export const chatRoom = actor({
  createState: () => ({
    members: [] as string[],
    unread: {} as Record<string, number>,
    pinned: null as Message | null,
    recent: [] as Message[],
    seq: 0,
    lastActivityAt: Date.now(),
    archiveId: null as string | null,
    archived: false,
  }),
  queues: { post: queue<{ from: string; text: string }>() },
  events: { newMessage: event<Message>(), archived: event<{ at: number }>() },
  run: async (c) => {
    for await (const m of c.queue.iter()) {
      const msg: Message = { seq: ++c.state.seq, ...m.body, at: Date.now() }
      c.state.recent = [...c.state.recent, msg].slice(-100)
      for (const user of c.state.members.filter((u) => u !== msg.from)) {
        c.state.unread[user] = (c.state.unread[user] ?? 0) + 1
      }
      c.state.lastActivityAt = msg.at
      await c.saveState({ immediate: true })
      c.broadcast("newMessage", msg)
    }
  },
  actions: {
    join: (c, user: string) => {
      c.state.members = [...new Set([...c.state.members, user])]
    },
    pin: (c, seq: number) => {
      c.state.pinned = c.state.recent.find((m) => m.seq === seq) ?? null
    },
    sendMessage: async (c, from: string, text: string) => {
      await c.queue.send("post", { from, text })
      if (c.state.archiveId) await c.schedule.cancel(c.state.archiveId)
      c.state.archiveId = await c.schedule.after(SEVEN_DAYS, "archive")
    },
    archive: (c) => {
      if (Date.now() - c.state.lastActivityAt < SEVEN_DAYS) return
      c.state.archived = true
      c.broadcast("archived", { at: Date.now() })
    },
  },
})

export const registry = setup({ use: { chatRoom } })
registry.start()
```

What this code gets from RivetKit:

- The `run` loop takes queue messages one at a time, so messages get one order.
- `c.broadcast` sends each new message to connected clients over WebSockets.
- The archive schedule survives a restart.

What to know:

- Actions run in parallel by default. That is why the messages go through a queue. The Rivet chat room guide calls one actor "a single serialized writer", and the actions page says that actions run in parallel. This design follows the actions page.
- A queue message is removed when the loop receives it. If a plain `run` loop fails before it completes the message, the message is not delivered again. Rivet Workflows record each message and retry failed steps.
- The `join`, `pin`, and `archive` actions change state directly. The queues page says "Actions are for getting data, queue entries are for mutating data". The sample also does not refuse a post to an archived room.
- The state is saved on a throttle. The example calls `c.saveState({ immediate: true })` before the broadcast.
- Two `sendMessage` calls can run at the same time, so the example also checks `lastActivityAt` before it archives.

### With Solid Objects

There is one `ChatRoom` actor for each room ID.

```typescript
import { Actor } from "solid-objects"

export const ARCHIVE_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1000

const KEPT_MESSAGES = 200

export type ChatMessage = { sequence: number; authorId: string; text: string }

export class ChatRoom extends Actor {
  static override readonly actorType = "ChatRoom"

  members: string[] = []
  messages: ChatMessage[] = []
  nextSequence = 1
  lastRead: Record<string, number> = {}
  pinned: ChatMessage | null = null
  activity = 0
  archived = false

  get unreadCounts(): Record<string, number> {
    const latest = this.nextSequence - 1
    return Object.fromEntries(
      this.members.map((memberId) => [memberId, latest - (this.lastRead[memberId] ?? 0)]),
    )
  }

  join({ memberId }: { memberId: string }): void {
    this.#requireOpen()
    if (this.members.includes(memberId)) return
    this.members = [...this.members, memberId]
    this.lastRead = { ...this.lastRead, [memberId]: this.nextSequence - 1 }
    this.#armArchive()
  }

  post({ authorId, text }: { authorId: string; text: string }): { sequence: number } {
    this.#requireMember(authorId)
    const sequence = this.nextSequence
    this.nextSequence += 1
    this.messages = [...this.messages, { sequence, authorId, text }].slice(-KEPT_MESSAGES)
    this.lastRead = { ...this.lastRead, [authorId]: sequence }
    this.#armArchive()
    return { sequence }
  }

  markRead({ memberId, sequence }: { memberId: string; sequence: number }): void {
    this.#requireMember(memberId)
    const current = this.lastRead[memberId] ?? 0
    this.lastRead = {
      ...this.lastRead,
      [memberId]: Math.min(Math.max(current, sequence), this.nextSequence - 1),
    }
  }

  pin({ memberId, sequence }: { memberId: string; sequence: number }): void {
    this.#requireMember(memberId)
    const message = this.messages.find((candidate) => candidate.sequence === sequence)
    if (!message) this.reject("unknown_message", { message: "That message is not in the room" })
    this.pinned = message
    this.#armArchive()
  }

  archiveIfIdle({ activity }: { activity: number }): void {
    if (activity !== this.activity) return
    this.archived = true
  }

  #requireMember(memberId: string): void {
    this.#requireOpen()
    if (!this.members.includes(memberId)) {
      this.reject("not_a_member", { message: "Join the room first" })
    }
  }

  #requireOpen(): void {
    if (this.archived) this.reject("archived", { message: "The room is archived" })
  }

  #armArchive(): void {
    this.activity += 1
    this.schedule({ at: new Date(Date.now() + ARCHIVE_AFTER_MILLISECONDS) }).archiveIfIdle({
      activity: this.activity,
    })
  }
}
```

The runtime policy lets a member act only in their own name. See [the runtime file](../../examples/compare/chat-runtime.ts). Its query policy only checks that the caller signed in. A production policy also checks room membership from your own data.

How it works:

- Calls for one room run one at a time, on any process. Each `post` gets the next sequence number, and the number commits with the message.
- `lastRead` keeps the last message that each member read. `unreadCounts` is a query that computes the counts from it.
- Each join, post, or pin moves the one `archiveIfIdle` reminder 7 days ahead and counts up `activity`. The reminder is a row in the database, so it runs after a restart. A reminder that was already queued behind a newer change carries an old count, so it does nothing. A post to an archived room gets `archived`.
- `pin` keeps a copy of the message, so the pinned text stays after newer messages push it out of the last 200.
- The actor keeps the last 200 messages in its state. Keep the full history in your own table with a commit action if you need it.
- For realtime updates, return the values that clients need from `observables()`, and connect clients through [the realtime layer](../api.md). Your app owns the WebSocket server.

### What the tests prove

[The tests](../../test/compare-chat-room.test.ts) show these results:

- Twenty messages from two members that arrive at the same time get the sequence numbers 1 to 20, with no gap.
- Unread counts are correct for each member after one member marks messages read.
- After a restart and seven idle days, the room is archived, keeps its pinned message, and refuses a new post.
- An archive reminder that was queued behind a newer post does nothing.
- A pinned message keeps its text after 200 newer messages.
- A member cannot post in the name of another member.
- A caller with no credentials cannot join or post, even with a `null` member ID.
- A caller who did not join cannot post.

## Questions that teams ask

**Is Solid Objects mature enough?** Here are the facts:

- Version 1.0.0: October 13, 2026. The public API follows [semantic versioning](../versioning.md).
- [Maintenance and continuity](../maintenance.md) tells you who maintains the project and how a release is made.
- One first-party application with more than 100,000 users runs it in production. That is a count of users, not a measure of load.
- The [benchmarks](../benchmarks.md) are development measurements. [Versioning](../versioning.md) states what version 1.0 does not claim.

**Why Node.js 24.4 or newer?** The SQLite adapter reads integer columns as `BigInt`. Node.js 24.4.0 is the first release that accepts `readBigInts` on the built-in SQLite module. See [support](../support.md).

**Is delivery exactly once?** No. Delivery is at least once. A turn can run again after a crash. Use the effect ID as the idempotency key for each external call. See [correctness](../correctness.md).

**What if one room is very busy?** One actor runs one turn at a time. A busy room handles its messages in sequence. Different rooms run at the same time.

**Does it need another process?** No new service. A process of your app calls `runtime.run(signal)` to run reminders and effects. While no process runs, pending work stays in SQL.

## Sources

Checked October 15, 2026:

- [Rivet overview](https://rivet.dev/docs/)
- [Rivet actor actions](https://rivet.dev/actors/docs/actions/)
- [Rivet actor queues](https://rivet.dev/actors/docs/queues/)
- [Rivet actor state](https://rivet.dev/actors/docs/state/)
- [Rivet actor scheduling](https://rivet.dev/actors/docs/schedule/)
- [Rivet actor events](https://rivet.dev/actors/docs/events/)
- [Rivet architecture](https://rivet.dev/docs/architecture/)
- [Rivet control plane storage](https://rivet.dev/docs/deploy/self-host/control-plane/storage/)
- [Rivet chat room guide](https://rivet.dev/guides/chat-room/)
- [Rivet Workflows: failure and recovery](https://rivet.dev/workflows/docs/failure-and-recovery)
- [rivetkit on npm](https://www.npmjs.com/package/rivetkit)

## More information

- [All comparisons](../comparisons.md)
- [Graphile Worker named queues and Solid Objects](graphile-worker.md)
- [Persistent rooms in Node.js](../guides/persistent-rooms.md)
- [Guide for coding agents](../agents.md)

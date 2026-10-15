# Graphile Worker named queues and Solid Objects: ordered work for each room on PostgreSQL

Graphile Worker is a job queue that stores jobs in PostgreSQL and runs them in Node.js. Jobs in the same named queue (`queueName`) run one at a time. Solid Objects (the `solid-objects` npm package) gives each key an actor with an ordered mailbox, durable state, and reminders, in the SQLite, PostgreSQL, or MySQL database that the app already uses. Choose Graphile Worker for background jobs, cron tasks, and work that does not belong to one key. Choose Solid Objects when one key, such as a chat room, has state that each change reads, and the order must hold after a failure.

Solid Objects is an independent project. It is not affiliated with Graphile.

## The short answer

| Question                | Graphile Worker                                                                                                                                                                                         | Solid Objects                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| What runs one at a time | Jobs in the same named queue. "Adding jobs to same named queue runs them in series"                                                                                                                     | Calls to the same actor ID                                                                    |
| Order after a failure   | The docs say "order is only maintained within each named queue", but not what happens after a failure. In the source code, a failed job gets a later `run_at`, so later jobs in the queue can run first | The failed message runs again. Later messages wait until it succeeds or becomes a dead letter |
| State for each key      | Your own tables                                                                                                                                                                                         | Actor fields                                                                                  |
| A worker crashes        | "each job will execute at least once". By default, a crashed worker's jobs "remain locked for at least 4 hours". `forceUnlockWorkers` can release them sooner                                           | The lease expires and the turn runs again. Delivery is at least once                          |
| Later work              | `runAt` with a `jobKey`                                                                                                                                                                                 | `this.schedule({ at, key }).operation(input)`                                                 |
| Recurring work          | A crontab                                                                                                                                                                                               | No crontab. A reminder can arm itself again for one actor                                     |
| Queue names             | "Avoid using high cardinality values (e.g., random strings, UUIDs, timestamps) for queue names"                                                                                                         | One actor ID for each key, at any count                                                       |
| What you run            | Worker processes (or the worker inside your server process) and PostgreSQL                                                                                                                              | Your Node.js process and your database                                                        |
| Database                | PostgreSQL 12 or newer                                                                                                                                                                                  | SQLite, PostgreSQL 14 or newer, MySQL 8.0 or newer                                            |
| Node.js                 | Node.js 22.18 or newer                                                                                                                                                                                  | Node.js 24.4 or newer                                                                         |
| Status                  | "Production ready (and used in production)", with 0.x version numbers                                                                                                                                   | Version 1.0                                                                                   |
| Licence                 | MIT. The Worker Pro add-on is proprietary                                                                                                                                                               | MIT. The optional Solid Objects Pro package is commercial                                     |

The Graphile Worker facts come from the [Graphile Worker documentation](https://worker.graphile.org/docs) and its [source code](https://github.com/graphile/worker) (checked October 15, 2026).

## Choose Graphile Worker when

- The work is background jobs, such as emails, webhooks, or reports.
- You need cron tasks.
- You want low latency from PostgreSQL `LISTEN` and `NOTIFY`.
- The state already lives in your own normalized tables, and each job is a short transaction on them.

## Choose Solid Objects when

- One key has state that each change reads and writes, and the changes must apply in order.
- The order must hold when one change fails.
- The keys are many, for example one for each room or each user. Graphile Worker advises against queue names with high cardinality.
- You use SQLite or MySQL.

## The same terms in each

| Graphile Worker                                   | Solid Objects                              |
| ------------------------------------------------- | ------------------------------------------ |
| `queueName`                                       | Actor ID                                   |
| A task                                            | An actor method (an operation)             |
| `addJob`                                          | A call on `runtime.ref(ActorClass, id)`    |
| `runAt` and `jobKey` with `jobKeyMode: "replace"` | `schedule({ at, key })` and an operation   |
| `maxAttempts` and the backoff formula             | `maxAttempts` and `retryDelayMilliseconds` |
| A crontab entry                                   | No equivalent                              |

## A chat room in each

The task: chat rooms in a Node.js TypeScript server with PostgreSQL. Several Node.js processes run. Messages in one room must get a strict order. Room state (members, unread counts, pinned message) must survive restarts. A room archives itself after 7 days with no activity. Rooms are independent of each other.

### With Graphile Worker

This code follows the Graphile Worker documentation. It was not compiled or run. The room state lives in `rooms`, `messages`, and `room_members` tables.

```typescript
import { makeWorkerUtils, run, type Task } from "graphile-worker"

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const connectionString = process.env.DATABASE_URL!
const workerUtils = await makeWorkerUtils({ connectionString })

export async function sendMessage(roomId: string, from: string, text: string) {
  await workerUtils.addJob("post_message", { roomId, from, text }, { queueName: `room:${roomId}` })
  await workerUtils.addJob(
    "archive_room",
    { roomId },
    {
      jobKey: `archive_room:${roomId}`,
      jobKeyMode: "replace",
      runAt: new Date(Date.now() + SEVEN_DAYS),
    },
  )
}

const post_message: Task = async (payload, helpers) => {
  const { roomId, from, text } = payload as { roomId: string; from: string; text: string }
  await helpers.withPgClient(async (pg) => {
    await pg.query("begin")
    try {
      const {
        rows: [room],
      } = await pg.query(
        "update rooms set seq = seq + 1, last_activity_at = now() where id = $1 returning seq",
        [roomId],
      )
      await pg.query("insert into messages (room_id, seq, sender, body) values ($1, $2, $3, $4)", [
        roomId,
        room.seq,
        from,
        text,
      ])
      await pg.query(
        "update room_members set unread = unread + 1 where room_id = $1 and user_id <> $2",
        [roomId, from],
      )
      await pg.query("commit")
    } catch (error) {
      await pg.query("rollback")
      throw error
    }
  })
}

const archive_room: Task = async (payload, helpers) => {
  const { roomId } = payload as { roomId: string }
  await helpers.query(
    "update rooms set archived_at = now() where id = $1 and last_activity_at <= now() - interval '7 days'",
    [roomId],
  )
}

const runner = await run({
  connectionString,
  concurrency: 5,
  taskList: { post_message, archive_room },
})
await runner.promise
```

What this code gets from Graphile Worker:

- Jobs in the queue `room:<id>` run one at a time.
- Each message job runs one SQL transaction, so the sequence number and the unread counts change together.
- The archive job with `jobKeyMode: "replace"` moves to 7 days after the newest message.

What to know:

- A failed job does not hold its place. In the source code, a failed job gets a later `run_at` from the backoff, and the next job in the queue runs. The documentation says that "order is only maintained within each named queue", but it does not say what happens after a failure.
- By default, a crashed worker's jobs stay locked for at least 4 hours, and the named queue waits with them. `workerUtils.forceUnlockWorkers` or Worker Pro can release them sooner.
- The sample does not refuse a post to an archived room.
- `withPgClient` does not open a transaction, so the task opens one.
- Delivery is at least once. A crash after `commit` can insert a message twice. Add a client message ID with a unique index.
- Graphile Worker has no realtime push. The app sends updates itself.
- One queue name for each room is a high-cardinality queue name. Graphile Worker advises against it and documents a `GC_JOB_QUEUES` cleanup task.

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
- If a turn throws, the runtime runs the same message again. Later messages for the room wait, so the order holds. See [errors and recovery](../errors-and-recovery.md).
- `lastRead` keeps the last message that each member read. `unreadCounts` is a query that computes the counts from it.
- Each join, post, or pin moves the one `archiveIfIdle` reminder 7 days ahead and counts up `activity`. The reminder is a row in the database, so it runs after a restart. A reminder that was already queued behind a newer change carries an old count, so it does nothing. A post to an archived room gets `archived`.
- `pin` keeps a copy of the message, so the pinned text stays after newer messages push it out of the last 200.
- The actor keeps the last 200 messages in its state. Keep the full history in your own table with a commit action if you need it.

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

- First public release of the npm package: August 13, 2026.
- Version 1.0.0: October 13, 2026. The public API follows [semantic versioning](../versioning.md).
- One maintainer.
- One first-party application with more than 100,000 users runs it in production. That is a count of users, not a measure of load. No production use by other people is known.
- The [benchmarks](../benchmarks.md) are development measurements. Longer soak tests are open work.

**Why Node.js 24.4 or newer?** The SQLite adapter reads integer columns as `BigInt`. Node.js 24.4.0 is the first release that accepts `readBigInts` on the built-in SQLite module. See [support](../support.md).

**Is delivery exactly once?** No. Delivery is at least once. A turn can run again after a crash. Use the effect ID as the idempotency key for each external call. See [correctness](../correctness.md).

**What if one room is very busy?** One actor runs one turn at a time. A busy room handles its messages in sequence. Different rooms run at the same time.

**Does it need another process?** Both run in your Node.js processes. Graphile Worker runs `run(...)`. Solid Objects runs `runtime.run(signal)` for reminders and effects. While no process runs, pending work stays in SQL.

**Can I use both?** Yes. Keep background jobs and cron in Graphile Worker, and keep state for each room in Solid Objects.

## Sources

Checked October 15, 2026:

- [Graphile Worker introduction](https://worker.graphile.org/docs)
- [Graphile Worker `addJob`](https://worker.graphile.org/docs/library/add-job)
- [Graphile Worker job keys](https://worker.graphile.org/docs/job-key)
- [Graphile Worker error handling](https://worker.graphile.org/docs/error-handling)
- [Graphile Worker exponential backoff](https://worker.graphile.org/docs/exponential-backoff)
- [Graphile Worker requirements](https://worker.graphile.org/docs/requirements)
- [Graphile Worker project status](https://worker.graphile.org/docs/project-status)
- [Graphile Worker techniques](https://worker.graphile.org/docs/techniques)
- [Graphile Worker admin functions](https://worker.graphile.org/docs/admin-functions)
- [Graphile Worker Pro](https://worker.graphile.org/docs/pro)
- [Graphile Worker `failJobs.ts`](https://github.com/graphile/worker/blob/main/src/sql/failJobs.ts) and [`getJobs.ts`](https://github.com/graphile/worker/blob/main/src/sql/getJobs.ts)

## More information

- [All comparisons](../comparisons.md)
- [RivetKit actors and Solid Objects](rivetkit.md)
- [Persistent rooms in Node.js](../guides/persistent-rooms.md)
- [Guide for coding agents](../agents.md)

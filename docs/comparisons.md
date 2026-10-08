# System comparisons

This guide compares coordination models so an application can choose the
smallest mechanism that meets its requirements. It does not rank the projects.
Solid Objects is a virtual actor library; the
[virtual actor guide](virtual-actors.md) defines the term. Facts about other
projects were checked on October 7, 2026.

| Approach                    | State and serialization unit             | Deployment and durable substrate                                                   | Separate service                                                                           | Replay versus state                                                             | Realtime and edge placement                                                                | Cross-identity transaction                                     | Data access                                                         |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| SQL transaction or row lock | Rows selected by one transaction         | Application process and SQL database                                               | No                                                                                         | The application retries a failed transaction                                    | Application-owned                                                                          | Yes, for rows in the same database transaction                 | Ordinary application tables and SQL tools                           |
| Traditional job queue       | A job, queue, or configured grouping key | Workers plus broker or queue database                                              | Usually                                                                                    | The job is retried; mutable entity state remains application-owned              | Application-owned                                                                          | Not supplied by the queue                                      | Queue administration plus application data stores                   |
| Solid Objects               | Actor class and application-defined ID   | Node processes plus existing SQLite, PostgreSQL, or MySQL                          | No; Redis wake-up is optional                                                              | The operation retries against durable actor state                               | Committed projections; application-owned transport; no edge placement                      | No                                                             | Relational tables, typed administration, CLI, and dashboard         |
| Cloudflare Durable Objects  | Object class and globally unique ID      | Cloudflare Workers plus per-object managed storage                                 | Cloudflare platform                                                                        | Object activation with durable state, not workflow-step replay                  | WebSockets and Cloudflare-selected object location                                         | Storage transactions are scoped to one object                  | Object storage APIs and platform tooling                            |
| celld                       | Object class and object name             | celld nodes plus one object-storage bucket; each object is its own SQLite database | Yes, the celld daemon on every node                                                        | The new owner restores the object's SQLite database from the bucket and resumes | Cloudflare Workers APIs; an object runs on one node of your fleet, not at an edge location | No                                                             | Per-object SQLite through the Workers storage APIs, plus the bucket |
| Rivet Actors                | Addressable actor                        | Rivet Engine or managed compute with actor state, KV, or per-actor SQLite          | Rivet Engine                                                                               | Actor persistence and lifecycle; workflows add recorded steps                   | Actor events and deployment-dependent placement                                            | No general transaction across actors                           | Actor APIs and selected persistence model                           |
| DBOS                        | Workflow ID and checkpointed steps       | Application processes plus PostgreSQL system database                              | No orchestration server for the library; Conductor is recommended for distributed recovery | Deterministic workflow replay skips checkpointed steps                          | Workflow events; application placement                                                     | PostgreSQL transactions remain separate from workflow identity | PostgreSQL system database, client, CLI, and optional Conductor     |
| Dapr actors                 | Actor type and ID, one turn at a time    | Application services plus Dapr sidecars and a transactional actor state store      | Yes: the Dapr sidecar plus the placement and Scheduler services                            | Actor state persists in the state store; actors do not replay workflow steps    | Sidecar-routed actor placement; no edge placement                                          | No transaction across actors                                   | Dapr actor APIs and the configured state store                      |
| Restate                     | Service handler or keyed virtual object  | Application services plus Restate's durable log and state store                    | Yes                                                                                        | Durable execution journals handler progress and object state                    | Service protocol and Restate deployment                                                    | No shared SQL transaction across object keys                   | Restate APIs, state tools, snapshots, and backups                   |
| Temporal                    | Workflow execution ID                    | Worker processes plus a Temporal Service, self-hosted or Temporal Cloud            | Yes, the Temporal Service                                                                  | Deterministic workflow code replays its event history                           | Workflow signals and queries; application placement                                        | No shared SQL transaction across workflows                     | Temporal SDK, CLI, and web UI                                       |

## Comparison vocabulary

Each row above differs on the same dimensions. For Solid Objects they are:

| Dimension        | Solid Objects                                                                      |
| ---------------- | ---------------------------------------------------------------------------------- |
| Identity         | An actor class and an application-defined ID                                       |
| Activation       | On demand, behind a fenced lease, released when idle                               |
| State storage    | A JSON document in SQLite, PostgreSQL, or MySQL                                    |
| Serialization    | One durable mailbox for each identity                                              |
| Delivery         | At least once, in order for each identity                                          |
| Reminders        | Durable and keyed for each actor                                                   |
| Recovery         | Another process claims the work after a lease expires; committed work waits in SQL |
| Deployment       | A library inside the application's Node.js processes                               |
| Operational cost | One retained message row for each call, plus database load                         |

## Primary references

- PostgreSQL documents row-lock behavior, transaction lifetime, and deadlock
  handling in [Explicit Locking](https://www.postgresql.org/docs/18/explicit-locking.html).
- BullMQ is one representative traditional queue; its
  [worker concurrency documentation](https://docs.bullmq.io/guide/workers/concurrency)
  distinguishes local concurrency from multiple worker processes.
- Cloudflare documents global uniqueness, per-object storage, single-threaded
  execution, and placement in [What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).
- celld documents per-object SQLite databases, bucket replication, and
  object-storage compare-and-swap ownership in its
  [repository](https://github.com/denoland/celld) and its
  [documentation](https://celld.dev/docs).
- Rivet documents addressable actors and persistence in
  [Actors](https://rivet.dev/docs/actors/) and
  [Persistence](https://rivet.dev/docs/actors/persistence).
- DBOS documents its PostgreSQL checkpoints, recovery, distributed processes,
  and optional control plane in [DBOS Architecture](https://docs.dbos.dev/architecture).
- Restate documents per-key write serialization in
  [Virtual Objects](https://docs.restate.dev/foundations/services#virtual-object)
  and its storage requirements in the
  [self-hosted server overview](https://docs.restate.dev/server/overview).

- Dapr documents virtual actors, the actor state store, and Scheduler-backed
  reminders in [Actors overview](https://docs.dapr.io/developing-applications/building-blocks/actors/actors-overview/)
  and [Actor timers and reminders](https://docs.dapr.io/developing-applications/building-blocks/actors/actors-timers-reminders/).
  The [JavaScript SDK](https://docs.dapr.io/developing-applications/sdks/js/js-actors/)
  supports actors.
- Temporal documents deterministic replay in
  [Workflow definition](https://docs.temporal.io/workflow-definition) and its
  service in [What is Temporal?](https://docs.temporal.io/temporal).
- Orleans documents virtual actors, turn-based scheduling, and reminders in its
  [overview](https://learn.microsoft.com/en-us/dotnet/orleans/overview),
  [Request scheduling](https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-scheduling),
  and [Timers and reminders](https://learn.microsoft.com/en-us/dotnet/orleans/grains/timers-and-reminders).
- Node.js documents CPU-bound parallelism in
  [Worker threads](https://nodejs.org/api/worker_threads.html).

External systems evolve. Recheck these primary sources before relying on one
row as a procurement or architecture decision.

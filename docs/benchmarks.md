# Benchmarks

The benchmark harness measures committed actor operations. It shows tradeoffs
and catches large regressions. It does not predict application capacity.

## Idle polling

The idle harness measures process CPU and empty database passes for the four
runtime roles:

```bash
pnpm run benchmark:idle
```

It warms each interval for three seconds, measures for ten seconds, and reports
process user plus system CPU time divided by wall time.

Measured on August 16, 2026 on an Apple M5 with Node.js 26.7.0 and in-memory
SQLite. The before run used 0.13.0; the after run used the prepared 0.13.1 tree.
Each run started one actor, effect, reminder, and broadcast role.

| Fast interval | Before polls/s | Before CPU | After polls/s | After CPU |
| ------------: | -------------: | ---------: | ------------: | --------: |
|         20 ms |         188.78 |     3.254% |         4.000 |    0.129% |
|        100 ms |         39.596 |     0.906% |         3.999 |    0.121% |
|        500 ms |          7.999 |     0.251% |         3.999 |    0.104% |

The after run reached the one-second ceiling for all four roles. These are
developer-laptop measurements, not a CPU guarantee; timer scheduling, JIT,
database path, and unrelated host activity affect short samples.

Five SQLite samples measured durable enqueue through committed completion after
2.5 seconds of idleness. The polling-only multi-process harness submits just
after an empty pass, so it measures approximately the full polling wait rather
than average arrival latency.

| Topology                        | 0.13.0 p50 | Prepared 0.13.1 p50 |
| ------------------------------- | ---------: | ------------------: |
| One process, in-process wake-up |   2.589 ms |            2.662 ms |
| Two processes, polling only     | 107.945 ms |        1,006.232 ms |

The local wake-up keeps the one-process path prompt after backoff. The
polling-only row is the explicit tradeoff: use PostgreSQL notifications or
optional Redis Pub/Sub when separate processes need low-latency delivery.

## Large state

The large-state harness measures how the committed state size changes
throughput. It runs one actor and one `increment()` operation with sequential
turns, so each row isolates the per-turn serialization and row write:

```bash
pnpm run benchmark:large-state
```

Use `--sizes`, `--operations`, and `--warmup` to change the recorded dataset.

Measured on August 29, 2026 on an Apple M5, macOS 26.6, Node.js 24.18.0, and
SQLite 3.53.1 through `node:sqlite` on a temporary file. Each row is the median
of three runs of 300 measured operations. The before column used the `0.14.3`
tree; the after column used the `0.14.4` tree, which removes the redundant
per-turn state serialization.

| Persisted state | Before ms/op | Before ops/s | After ms/op | After ops/s | Gain |
| --------------: | -----------: | -----------: | ----------: | ----------: | ---: |
|            0 KB |         1.85 |          540 |        1.60 |         625 | 1.2x |
|           16 KB |         2.12 |          472 |        1.64 |         611 | 1.3x |
|          128 KB |         4.01 |          250 |        2.53 |         395 | 1.6x |
|            1 MB |        19.11 |           52 |        9.32 |         107 | 2.1x |

The before tree traversed the whole state eight times for each committed
operation, and nine times for a query. The after tree traverses it four times:
one image for rollback and comparison, one committed image, and one read for
each of the two observables guards. The remaining cost at 1 MB is the database
write of a large row, which the whole-image commit model cannot avoid.

The curve, not the ratio, is the operating instruction. Throughput falls by
about 6x between 0 KB and 1 MB even after the change. Keep one actor's state
small. See
[State size and throughput](state-and-lifecycle.md#state-size-and-throughput).

## Scenarios

- `warm-hot`: all operations target one previously created identity.
- `warm-many`: operations rotate across 100 previously created identities.
- `cold-many`: every measured operation creates a new identity.
- `synchronous`: the actor method mutates state without yielding.
- `asynchronous`: the actor method yields through `setImmediate()` before the
  same mutation.
- `one-process`: four actor workers run in the caller's Node process.
- `four-processes`: four Node worker processes share the database.

Latency begins before durable enqueue and ends when the committed result is
available. Throughput uses the wall time for the measured batch. Percentiles
use nearest rank. Defaults are 25 warmup operations, 250 measured operations,
and client concurrency 16.

## Run the harness

SQLite needs no service:

```bash
pnpm run benchmark -- --database sqlite
```

PostgreSQL and MySQL runs require a disposable database. The harness deletes
benchmark rows but leaves its uniquely prefixed empty tables for inspection.

```bash
SOLID_OBJECTS_POSTGRESQL_BENCHMARK_URL=postgresql://... \
  pnpm run benchmark -- --database postgresql

SOLID_OBJECTS_MYSQL_BENCHMARK_URL=mysql://... \
  pnpm run benchmark -- --database mysql
```

Use `--operations`, `--warmup`, and `--concurrency` to change the recorded
dataset. Redirect stdout to retain the JSON result.

## Observed results

Measured on August 22, 2026 with the `0.14.0` source tree:

- Apple M5 (Mac17,2), 10 logical CPUs
- macOS 26.6
- Node.js 24.18.0
- SQLite 3.53.1 through `node:sqlite` on the internal SSD
- PostgreSQL 17.11 and MySQL 9.7.1, both installed natively and started on a
  scoped temporary data directory
- 25 warmup operations, 250 measured operations, concurrency 16

### SQLite 3.53.1

| Topology       | Shape     | Handler      |  ops/s | p50 ms | p95 ms | p99 ms |
| -------------- | --------- | ------------ | -----: | -----: | -----: | -----: |
| one process    | warm hot  | synchronous  | 286.09 |  50.09 | 135.15 | 176.55 |
| one process    | warm hot  | asynchronous | 322.53 |  48.66 |  70.59 |  75.87 |
| one process    | warm many | synchronous  | 119.05 | 132.25 | 237.52 | 247.05 |
| one process    | warm many | asynchronous | 288.26 |  32.64 |  70.33 | 562.42 |
| one process    | cold many | synchronous  |  47.67 | 326.04 | 435.46 | 507.03 |
| one process    | cold many | asynchronous |  99.39 |    148 | 236.03 | 295.26 |
| four processes | warm hot  | synchronous  | 518.66 |  30.15 |  52.73 |  78.57 |
| four processes | warm hot  | asynchronous |  506.8 |  26.39 |  92.26 | 102.18 |
| four processes | warm many | synchronous  | 190.36 |  76.65 |  145.7 | 158.94 |
| four processes | warm many | asynchronous |  77.12 |  194.6 | 399.43 |  527.1 |
| four processes | cold many | synchronous  |  54.74 | 273.33 | 646.68 | 650.09 |
| four processes | cold many | asynchronous |  93.85 | 145.27 | 333.78 |  426.6 |

### PostgreSQL 17.11

| Topology       | Shape     | Handler      |  ops/s | p50 ms | p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | -----: | -----: | ------: |
| one process    | warm hot  | synchronous  | 206.31 |  69.33 | 132.69 |  153.03 |
| one process    | warm hot  | asynchronous | 212.07 |  72.38 |  96.75 |  106.12 |
| one process    | warm many | synchronous  |  191.4 |  55.71 | 147.99 |   722.6 |
| one process    | warm many | asynchronous |   66.6 | 121.61 | 920.97 | 2441.28 |
| one process    | cold many | synchronous  |  31.38 | 500.73 | 705.15 |  722.54 |
| one process    | cold many | asynchronous |  17.24 | 909.02 | 1192.9 | 1211.35 |
| four processes | warm hot  | synchronous  | 265.63 |  57.94 |  82.52 |  109.46 |
| four processes | warm hot  | asynchronous | 330.94 |  46.81 |  63.76 |   70.25 |
| four processes | warm many | synchronous  | 161.73 |  58.67 | 237.04 |  718.55 |
| four processes | warm many | asynchronous | 119.63 |  68.71 | 531.12 |  1372.5 |
| four processes | cold many | synchronous  |  50.84 | 314.51 | 487.09 |  506.45 |
| four processes | cold many | asynchronous |  29.93 |  546.7 | 615.36 |   638.1 |

### MySQL 9.7.1

| Topology       | Shape     | Handler      |  ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | ------: | ------: | ------: |
| one process    | warm hot  | synchronous  |  79.59 |  208.66 |  222.86 |  225.19 |
| one process    | warm hot  | asynchronous |  79.98 |  206.78 |  232.74 |  237.94 |
| one process    | warm many | synchronous  |   79.7 |  129.25 |  395.52 | 1987.46 |
| one process    | warm many | asynchronous |  28.06 |  338.85 | 1992.54 | 6004.98 |
| one process    | cold many | synchronous  |  13.78 | 1215.91 | 1445.61 | 1470.91 |
| one process    | cold many | asynchronous |  11.63 | 1347.74 | 1733.01 | 1820.26 |
| four processes | warm hot  | synchronous  | 213.75 |   72.85 |   94.48 |  106.73 |
| four processes | warm hot  | asynchronous | 228.32 |   70.45 |   84.96 |   90.39 |
| four processes | warm many | synchronous  | 105.31 |   90.36 |  297.88 | 1064.14 |
| four processes | warm many | asynchronous |  80.03 |  149.92 |  324.98 | 1090.95 |
| four processes | cold many | synchronous  |  51.82 |   306.1 |  407.22 |  424.45 |
| four processes | cold many | asynchronous |  27.35 |  554.03 |  807.18 |  868.48 |

The cold and asynchronous cases keep the poorest throughput and the longest
tail. These are observed limitations. They are not capacity recommendations.
Repeat the runs on application-shaped payloads before you draw a general
conclusion. Integration tests cover PostgreSQL 14, MySQL 8.0, and other database
versions, but this harness did not measure them.

### Virtualization cost

The same server version ran natively and in Docker Desktop on the same machine,
on the same day, through the same harness. Only the container boundary changes.

| Database         | Topology and shape              | Native ops/s | Docker ops/s | Native gain |
| ---------------- | ------------------------------- | -----------: | -----------: | ----------: |
| PostgreSQL 17.11 | four processes, warm hot, async |       330.94 |        67.69 |        4.9x |
| PostgreSQL 17.11 | one process, warm hot, sync     |       206.31 |        56.44 |        3.7x |
| MySQL 9.7.1      | four processes, warm hot, async |       228.32 |        60.27 |        3.8x |
| MySQL 9.7.1      | one process, warm hot, sync     |        79.59 |        44.56 |        1.8x |

Across the full matrix, Docker Desktop cost between 1.0x and 7.8x of the native
throughput. The multi-process rows lose the most, because more connections and
more commits cross the container boundary. Measure a database on the deployment
shape you intend to run, and state the boundary with any number you publish.

Earlier releases of this document reported PostgreSQL 18.4 and MySQL 8.4.11 in
Docker Desktop on the `0.13.0` tree. Those numbers measured the container as
much as the database, so the tables above replace them.

## Sources of bias

- A developer laptop shares CPU, memory, and storage with unrelated processes.
- Loopback database connections exclude production network latency.
- Filesystem cache, SQLite WAL state, Node JIT warmup, and garbage collection
  affect short runs.
- Docker Desktop costs between 1.0x and 7.8x of the native throughput. The
  tables above use native servers. See [Virtualization cost](#virtualization-cost).
- The payload is a small counter, not a representative application state size.
  See [Large state](#large-state) for the measured effect of state size.
- The harness measures default durability settings and one client concurrency.
- Hot-identity results deliberately include serialization and cannot be scaled
  by adding workers.

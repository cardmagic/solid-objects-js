# Historical benchmark measurements

These datasets retain their original runtime versions, machines, database settings and measurement
boundaries. Use them as records of those environments. The [current benchmark guide](benchmarks.md)
separately identifies controlled release comparisons and isolated single-version baselines.

## Historical shared-workstation 1.0.5 measurements

This historical dataset runs the released `v1.0.5` source at commit
`8975f6e2ad94c114f3638cea8f167956061a9bc3`. The runtime source is unchanged; the measurement harness
is overlaid from this repository. Every JSON report records that source revision, runtime source and
built-artifact SHA-256 values, harness SHA-256, the loaded package version, actual driver versions,
database version, host, and Node version. At collection time, the development branch also reported
1.0.5 but contained SQLite WAL changes absent from the release tag. Use the recorded source and
artifact hashes to reproduce the measured 1.0.5 implementation. Version 1.0.6 includes the later
SQLite WAL changes.

The archived reports were collected with harness revision
`da5fe31b1ffa18eca92ce43fc26bca619d424d6e`. They verified committed operation
counts. The current collector additionally verifies cart quantities, totals, and
one pending effect with the correct total for every committed operation, after
the timed interval. Those additional assertions were not run retrospectively on
the archived measurements.

### Recorded environment and results

Measured November 7, 2026 on Apple M2 Ultra, 24 logical CPUs, 64 GiB RAM, darwin 27.2.0, and Node.js
v24.18.0. Drivers were pg 8.23.0 and mysql2 3.23.3.

The workstation was concurrently used for other development tasks. CPU and storage activity were
shared. Absolute timings and workload comparisons require controlled repeats before capacity
planning. For example, the three SQLite four-process synchronous hot-counter samples were 17.89,
20.69, 79.42 operations/second. Every sample is retained.

[Complete tables and raw reports](../benchmarks/results/v1.0.5-2026-11-07/README.md)
include all 216 matrix rows, 12 state-size rows, three idle rows, and 57,600 individual operation
latencies.

| Database   | Version          | Durability settings                         |
| ---------- | ---------------- | ------------------------------------------- |
| sqlite     | 3.53.1           | `journalMode=delete, synchronous=2`         |
| postgresql | 16.15 (Homebrew) | `fsync=on, synchronousCommit=on`            |
| mysql      | 26.10.0          | `innodbFlushLogAtTrxCommit=1, syncBinlog=1` |

The next table shows synchronous handlers with four worker processes. One-process and
yielding-handler results are in the complete tables.

| Database   | Workload    | Shape     |  ops/s |  p50 ms |   p95 ms |   p99 ms |
| ---------- | ----------- | --------- | -----: | ------: | -------: | -------: |
| sqlite     | counter     | warm-hot  |  20.69 |  733.52 | 1,595.35 | 1,754.31 |
| sqlite     | counter     | warm-many |  13.51 |  818.09 | 3,205.47 |  6,056.1 |
| sqlite     | counter     | cold-many |   5.77 | 2,497.5 | 5,538.34 | 6,346.58 |
| sqlite     | cart-outbox | warm-hot  | 106.27 |  147.92 |   205.03 |   283.86 |
| sqlite     | cart-outbox | warm-many |  56.87 |  264.62 |    454.1 |   588.05 |
| sqlite     | cart-outbox | cold-many |   35.4 |  393.17 |  1,037.9 | 1,286.45 |
| postgresql | counter     | warm-hot  |  88.84 |  160.37 |   275.92 |   293.19 |
| postgresql | counter     | warm-many | 146.88 |   70.92 |   176.45 | 1,103.97 |
| postgresql | counter     | cold-many |  20.25 |  808.09 | 1,069.78 | 1,140.48 |
| postgresql | cart-outbox | warm-hot  |  99.15 |  159.81 |   227.97 |   244.67 |
| postgresql | cart-outbox | warm-many | 107.12 |   93.49 |   253.75 |  1,307.5 |
| postgresql | cart-outbox | cold-many |  21.56 |   651.8 |    979.4 | 1,056.95 |
| mysql      | counter     | warm-hot  |   72.5 |  200.22 |   328.44 |   390.64 |
| mysql      | counter     | warm-many | 105.16 |   58.47 |   363.58 | 1,728.53 |
| mysql      | counter     | cold-many |  31.69 |   445.1 |   935.43 | 1,060.47 |
| mysql      | cart-outbox | warm-hot  |  52.96 |  287.93 |   408.07 |   446.53 |
| mysql      | cart-outbox | warm-many |  74.75 |  134.94 |   549.13 | 1,926.81 |
| mysql      | cart-outbox | cold-many |  20.69 |  720.19 | 1,118.29 | 1,176.44 |

State-size results use sequential operations on one actor in a SQLite file:

| Payload KiB | Persisted state bytes | ops/s | p50 ms | p95 ms | p99 ms |
| ----------: | --------------------: | ----: | -----: | -----: | -----: |
|           0 |                    26 |  93.6 |   9.29 |  21.09 |  26.88 |
|          16 |                16,410 | 86.65 |   10.4 |  21.12 |  26.33 |
|         128 |               131,098 |  70.4 |  12.86 |  22.93 |  27.15 |
|       1,024 |             1,048,602 | 42.27 |  22.55 |  33.05 |  42.64 |

Idle CPU uses one timed sample per interval, in-memory SQLite, and all four polling roles:

| Fast interval ms | Empty polls/s | Process CPU |
| ---------------: | ------------: | ----------: |
|               20 |             4 |       0.12% |
|              100 |             4 |       0.12% |
|              500 |             4 |        0.1% |

### Workloads and measurement boundary

The counter matrix includes one hot identity, 100 warm identities, and newly created identities,
each with synchronous and yielding handlers and one or four processes. A second matrix uses a cart
with 20 line items. Every cart operation updates a quantity, recalculates the total, and commits one
outbox effect with the actor state. Effect workers are disabled: the cart results measure durable
outbox staging, not delivery to an external service. The yielding handler uses `setImmediate()`; it
does not model external network latency.

Each scenario has three separate samples of 250 measured operations after 25 warmup operations, at
client concurrency 16 and four actor workers. Counters are verified against all submitted operations
after the timed batch. Tables report the median of each statistic across the three samples.
Percentiles use nearest rank within each sample; samples are not pooled. The raw JSON retains all
operation latencies, including slow samples. This short run is a development measurement, not a soak
test or an application capacity guarantee.

The state-size run has three samples of 300 operations after 25 warmups, at concurrency one. It
verifies final committed count and payload size, records actual serialized state bytes, and retains
operation latencies. Idle CPU uses three seconds of warmup and ten seconds of measurement per
polling interval. The historical idle wake-up latency table below has not been rerun as part of this
dataset.

### Reproduce the released runtime

Use a separate checkout so later runtime changes cannot enter the result. Install the locked
dependencies and overlay the measurement harness from the commit containing this dataset before
building the runtime:

```bash
# Run from your normal checkout; pin the collector used by the archived reports.
repository_root=$(pwd)
harness_ref=da5fe31b1ffa18eca92ce43fc26bca619d424d6e
# To collect new results with the stronger verifier instead:
# harness_ref=$(git rev-parse HEAD)
git worktree add --detach /tmp/solid-objects-v1.0.5 v1.0.5
git archive "$harness_ref" benchmarks | tar -x -C /tmp/solid-objects-v1.0.5
cd /tmp/solid-objects-v1.0.5
pnpm install --frozen-lockfile
pnpm exec tsc -p tsconfig.build.json
git diff --exit-code v1.0.5 -- src

node benchmarks/run.ts --database sqlite --workload counter \
  --operations 250 --warmup 25 --repetitions 3 > sqlite-counter.json
node benchmarks/run.ts --database sqlite --workload cart-outbox \
  --operations 250 --warmup 25 --repetitions 3 > sqlite-cart-outbox.json
node benchmarks/large-state.ts --operations 300 --warmup 25 \
  --repetitions 3 > sqlite-large-state.json
node benchmarks/idle.ts > sqlite-idle.json
cd "$repository_root"
```

Repeat the matrix with `--database postgresql` and `--database mysql` and the benchmark URLs shown
below, using disposable local databases. Reports contain driver versions and durability settings
without connection URLs or credentials. Run all scenarios sequentially. Use the recorded host, Node,
database settings, and driver versions when comparing results; ordinary shared-host activity and
storage behavior still affect them.

Generate the complete tables from the retained reports with:

```bash
node benchmarks/summarize.mjs benchmarks/results/v1.0.5-2026-11-07/*.json
```

The summarizer rejects mixed runtime/harness provenance, missing scenarios or samples, and missing
per-operation latencies. Keep the per-sample JSON when reporting a median so the variability remains
reviewable.

The August measurements below retain their original versions, hardware, and methodology.

## Idle polling

The idle harness measures process CPU and empty database passes for the four runtime roles:

```bash
pnpm run benchmark:idle
```

It warms each interval for three seconds, measures for ten seconds, and reports process user plus
system CPU time divided by wall time.

Measured on August 16, 2026 on an Apple M5 with Node.js 26.7.0 and in-memory SQLite. The before run
used 0.13.0; the after run used the prepared 0.13.1 tree. Each run started one actor, effect,
reminder, and broadcast role.

| Fast interval | Before polls/s | Before CPU | After polls/s | After CPU |
| ------------: | -------------: | ---------: | ------------: | --------: |
|         20 ms |         188.78 |     3.254% |         4.000 |    0.129% |
|        100 ms |         39.596 |     0.906% |         3.999 |    0.121% |
|        500 ms |          7.999 |     0.251% |         3.999 |    0.104% |

The after run reached the one-second ceiling for all four roles. These are developer-laptop
measurements, not a CPU guarantee; timer scheduling, JIT, database path, and unrelated host activity
affect short samples.

Five SQLite samples measured durable enqueue through committed completion after 2.5 seconds of
idleness. The polling-only multi-process harness submits just after an empty pass, so it measures
approximately the full polling wait rather than average arrival latency.

| Topology                        | 0.13.0 p50 | Prepared 0.13.1 p50 |
| ------------------------------- | ---------: | ------------------: |
| One process, in-process wake-up |   2.589 ms |            2.662 ms |
| Two processes, polling only     | 107.945 ms |        1,006.232 ms |

The local wake-up keeps the one-process path prompt after backoff. The polling-only row is the
explicit tradeoff: use PostgreSQL notifications or optional Redis Pub/Sub when separate processes
need low-latency delivery.

## Large state

The large-state harness measures how the committed state size changes throughput. It runs one actor
and one `increment()` operation with sequential turns, so each row isolates the per-turn
serialization and row write:

```bash
pnpm run benchmark:large-state
```

Use `--sizes`, `--operations`, and `--warmup` to change the recorded dataset.

Measured on August 29, 2026 on an Apple M5, macOS 26.6, Node.js 24.18.0, and SQLite 3.53.1 through
`node:sqlite` on a temporary file. Each row is the median of three runs of 300 measured operations.
The before column used the `0.14.3` tree; the after column used the `0.14.4` tree, which removes the
redundant per-turn state serialization.

| Persisted state | Before ms/op | Before ops/s | After ms/op | After ops/s | Gain |
| --------------: | -----------: | -----------: | ----------: | ----------: | ---: |
|            0 KB |         1.85 |          540 |        1.60 |         625 | 1.2x |
|           16 KB |         2.12 |          472 |        1.64 |         611 | 1.3x |
|          128 KB |         4.01 |          250 |        2.53 |         395 | 1.6x |
|            1 MB |        19.11 |           52 |        9.32 |         107 | 2.1x |

The before tree traversed the whole state eight times for each committed operation, and nine times
for a query. The after tree traverses it four times: one image for rollback and comparison, one
committed image, and one read for each of the two observables guards. The remaining cost at 1 MB is
the database write of a large row, which the whole-image commit model cannot avoid.

The curve, not the ratio, is the operating instruction. Throughput falls by about 6x between 0 KB
and 1 MB even after the change. Keep one actor's state small. See
[State size and throughput](state-and-lifecycle.md#state-size-and-throughput).

## Historical August 0.14.0 matrix

Measured on August 22, 2026 with the `0.14.0` source tree:

- Apple M5 (Mac17,2), 10 logical CPUs
- macOS 26.6
- Node.js 24.18.0
- SQLite 3.53.1 through `node:sqlite` on the internal SSD
- PostgreSQL 17.11 and MySQL 9.7.1, both installed natively and started on a scoped temporary data
  directory
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

The cold and asynchronous cases keep the poorest throughput and the longest tail. These are observed
limitations. They are not capacity recommendations. Repeat the runs on application-shaped payloads
before you draw a general conclusion. Integration tests cover PostgreSQL 14, MySQL 8.0, and other
database versions, but this harness did not measure them.

### Virtualization cost

In the August experiment, the same server version ran natively and in Docker Desktop on the same machine, on the same day,
through the same harness. Only the container boundary changes.

| Database         | Topology and shape              | Native ops/s | Docker ops/s | Native gain |
| ---------------- | ------------------------------- | -----------: | -----------: | ----------: |
| PostgreSQL 17.11 | four processes, warm hot, async |       330.94 |        67.69 |        4.9x |
| PostgreSQL 17.11 | one process, warm hot, sync     |       206.31 |        56.44 |        3.7x |
| MySQL 9.7.1      | four processes, warm hot, async |       228.32 |        60.27 |        3.8x |
| MySQL 9.7.1      | one process, warm hot, sync     |        79.59 |        44.56 |        1.8x |

Across the full matrix, Docker Desktop cost between 1.0x and 7.8x of the native throughput. The
multi-process rows lose the most, because more connections and more commits cross the container
boundary. Measure a database on the deployment shape you intend to run, and state the boundary with
any number you publish.

Earlier releases of this document reported PostgreSQL 18.4 and MySQL 8.4.11 in Docker Desktop on the
`0.13.0` tree. Those numbers measured the container as much as the database, so the tables above
replace them.

## Sources of bias

- A developer laptop shares CPU, memory, and storage with unrelated processes.
- Loopback database connections exclude production network latency.
- Filesystem cache, SQLite WAL state, Node JIT warmup, and garbage collection affect short runs.
- The August Docker Desktop experiment measured 1.0x to 7.8x lower throughput than native
  servers. That is not a prediction for Docker on a Linux runner. See [Virtualization cost](#virtualization-cost).
- The payload is a small counter, not a representative application state size. See
  [Large state](#large-state) for the measured effect of state size.
- Historical baselines use default durability and client concurrency 16. Comparisons must state
  each tested concurrency and actual durability setting.
- Hot-identity results deliberately include serialization and cannot be scaled by adding workers.

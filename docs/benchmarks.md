# Benchmarks

The benchmark harness measures committed actor operations. It is intended to
show tradeoffs and catch large regressions, not to predict application capacity.

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

Measured on August 15, 2026 with the prepared `0.13.0` source tree:

- Apple M5, 10 logical CPUs, 24 GiB memory
- macOS 26.6 (`darwin 25.6.0`)
- Node.js 26.7.0
- SQLite 3.53.4 on the internal SSD, PostgreSQL 18.4 and MySQL 8.4.11 in
  Docker Desktop
- 25 warmup operations, 250 measured operations, concurrency 16

### SQLite 3.53.4

| Topology       | Shape     | Handler      |  ops/s | p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | -----: | ------: | ------: |
| one process    | warm hot  | synchronous  |  95.51 |  35.34 | 1159.07 | 1711.76 |
| one process    | warm hot  | asynchronous | 448.63 |  35.96 |   38.95 |   41.47 |
| one process    | warm many | synchronous  |  44.35 | 141.55 | 1886.35 | 2543.15 |
| one process    | warm many | asynchronous | 240.64 |  48.62 |   75.10 |  671.64 |
| one process    | cold many | synchronous  |  30.91 | 436.98 | 1502.26 | 1729.10 |
| one process    | cold many | asynchronous |  57.15 | 167.36 |  967.74 | 1066.49 |
| four processes | warm hot  | synchronous  | 453.10 |  27.24 |   72.09 |   77.88 |
| four processes | warm hot  | asynchronous | 487.39 |  29.27 |   60.66 |   68.28 |
| four processes | warm many | synchronous  |  78.88 |  86.33 |  890.29 | 1381.65 |
| four processes | warm many | asynchronous |  47.56 | 220.37 | 1130.53 | 1341.86 |
| four processes | cold many | synchronous  |  70.45 | 174.67 |  643.53 |  668.46 |
| four processes | cold many | asynchronous |  39.92 | 221.01 | 1309.13 | 1442.30 |

### PostgreSQL 18.4

| Topology       | Shape     | Handler      | ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | ----: | ------: | ------: | ------: |
| one process    | warm hot  | synchronous  | 66.99 |  232.89 |  317.94 |  375.68 |
| one process    | warm hot  | asynchronous | 72.27 |  211.57 |  280.89 |  316.61 |
| one process    | warm many | synchronous  | 76.69 |  129.88 |  552.01 | 1963.27 |
| one process    | warm many | asynchronous | 25.78 |  340.96 | 2326.38 | 6917.26 |
| one process    | cold many | synchronous  | 12.70 | 1262.08 | 1734.77 | 2199.20 |
| one process    | cold many | asynchronous | 11.23 | 1254.46 | 2796.81 | 2905.99 |
| four processes | warm hot  | synchronous  | 83.71 |  191.83 |  220.87 |  231.84 |
| four processes | warm hot  | asynchronous | 86.42 |  184.56 |  210.11 |  215.48 |
| four processes | warm many | synchronous  | 95.47 |  100.31 |  330.27 | 1663.84 |
| four processes | warm many | asynchronous | 37.04 |  232.71 | 1601.29 | 4447.85 |
| four processes | cold many | synchronous  | 14.79 | 1114.18 | 1263.33 | 1313.70 |
| four processes | cold many | asynchronous | 11.68 | 1231.94 | 2555.34 | 2848.80 |

### MySQL 8.4.11

| Topology       | Shape     | Handler      | ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | ----: | ------: | ------: | ------: |
| one process    | warm hot  | synchronous  | 28.11 |  504.36 | 1648.10 | 2088.05 |
| one process    | warm hot  | asynchronous | 25.29 |  508.26 | 1750.17 | 2222.72 |
| one process    | warm many | synchronous  | 61.79 |  165.62 |  463.59 | 2036.31 |
| one process    | warm many | asynchronous | 22.45 |  446.17 | 2420.92 | 7818.65 |
| one process    | cold many | synchronous  | 10.23 | 1353.37 | 3038.76 | 3185.15 |
| one process    | cold many | asynchronous | 10.04 | 1338.31 | 3344.18 | 3477.06 |
| four processes | warm hot  | synchronous  | 29.89 |  427.18 | 1483.88 | 1997.56 |
| four processes | warm hot  | asynchronous | 27.59 |  448.16 | 1518.00 | 1589.57 |
| four processes | warm many | synchronous  | 69.77 |  157.79 |  410.83 | 2263.13 |
| four processes | warm many | asynchronous | 36.21 |  265.24 | 1579.43 | 4594.33 |
| four processes | cold many | synchronous  | 13.68 | 1088.93 | 2186.30 | 2519.92 |
| four processes | cold many | asynchronous | 11.38 | 1209.84 | 2532.38 | 2730.74 |

The poor throughput and tail latency in cold and asynchronous cases are
observed limitations, not capacity recommendations. The small asynchronous
yield changed scheduling enough to improve some cases and worsen others;
repeat runs on application-shaped payloads are required before drawing a
general conclusion. PostgreSQL 14, MySQL 8.0, and other database versions are
covered by integration tests but were not benchmarked.

## Sources of bias

- A developer laptop shares CPU, memory, and storage with unrelated processes.
- Loopback database connections exclude production network latency.
- Filesystem cache, SQLite WAL state, Node JIT warmup, and garbage collection
  affect short runs.
- Docker Desktop adds virtualization overhead to containerized databases.
- The payload is a small counter, not a representative application state size.
- The harness measures default durability settings and one client concurrency.
- Hot-identity results deliberately include serialization and cannot be scaled
  by adding workers.

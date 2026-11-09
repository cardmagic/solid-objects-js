# Benchmarks

The benchmark harness measures committed actor operations. It shows tradeoffs and catches large
regressions. It does not predict application capacity.

## Which measurements answer which question?

A package version is not a benchmark result. Read the release, hardware, database settings,
workload and harness together. Numbers from different environments do not establish a code
regression or speedup. In particular, dividing the August M5 figures by the November busy-Mac
figures is not a release comparison.

| Dataset                                                                         | Runtime measured                             | Environment                            | What it establishes                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| [Isolated baseline](../benchmarks/results/v1.0.5-isolated-2026-11-08/README.md) | 1.0.5                                        | Dedicated DigitalOcean c-8, November 8 | Reproducible single-version baseline, including raw samples and confirmed teardown |
| [Shared workstation](../benchmarks/results/v1.0.5-2026-11-07/README.md)         | 1.0.5                                        | Busy M2 Ultra, November 7              | Historical observations; unsuitable for attributing a version regression           |
| [August archive](benchmarks-history.md#historical-august-0140-matrix)           | 0.14.0 (matrix), 0.14.3/0.14.4 (state sizes) | M5 developer laptop                    | Historical measurements in their original environments                             |

The [dataset catalog](../benchmarks/results/index.json) records measured versions and environment
classes. `pnpm run check:benchmarks` verifies those labels against raw reports, rechecks summaries,
and requires successful download and confirmed teardown for isolated cloud datasets. CI runs this
check; a new release does not change any existing dataset's measured version. Headline tables
are generated from those same reports with `pnpm run check:benchmarks --write-guide` and checked
for stale values in CI.

Version 1.0.6 changes file-backed SQLite from DELETE/FULL to WAL/NORMAL. That changes both
journal behavior and power-loss durability. Its results must be labeled separately from
1.0.5, with WAL/FULL measured as a separate control. Do not relabel a 1.0.5 dataset as 1.0.6.

The [1,000-operation feasibility pilot](../benchmarks/results/js-release-comparison-pilot-2026-11-09/README.md)
was stopped after its first complete SQLite round showed the expanded matrix would exceed the
three-hour measurement deadline. All completed and partial reports are retained, with the original
plan and confirmed deletion. It is incomplete and is excluded from the controlled comparison.
The replacement fixes 500 operations per condition before provisioning a fresh runner, while
keeping five repetitions, 100 warmups, every version, both concurrency levels and all scenarios.

## Isolated 1.0.5 baseline

The November 8 run uses an otherwise dedicated DigitalOcean c-8 in sfo3, eight dedicated vCPUs,
16 GiB RAM, Ubuntu 24.04, Node 24.18.0, and pinned PostgreSQL/MySQL images on the same host.
Collection waits for boot to settle and a sustained CPU, storage and load quiet period. The
[archived profile and lifecycle](../benchmarks/results/v1.0.5-isolated-2026-11-08/run.json),
[host metadata](../benchmarks/results/v1.0.5-isolated-2026-11-08/host.txt) and
[quiet samples](../benchmarks/results/v1.0.5-isolated-2026-11-08/quiet.jsonl) are retained.

For counter operations with four processes, synchronous handlers and client concurrency 16,
these are the median, minimum and maximum throughput across all three retained samples:

<!-- benchmark-table: v1.0.5-isolated-2026-11-08 -->

| Database   | Shape     | Median ops/s | Minimum ops/s | Maximum ops/s |
| ---------- | --------- | -----------: | ------------: | ------------: |
| sqlite     | warm-hot  |       198.83 |        196.78 |        206.03 |
| sqlite     | warm-many |        69.08 |         65.76 |         73.95 |
| sqlite     | cold-many |        34.78 |         34.42 |         35.39 |
| postgresql | warm-hot  |        97.05 |         96.96 |        102.59 |
| postgresql | warm-many |       142.57 |        138.77 |        147.83 |
| postgresql | cold-many |         28.5 |         28.33 |         28.71 |
| mysql      | warm-hot  |        71.23 |         65.77 |         77.93 |
| mysql      | warm-many |        79.46 |         60.76 |        107.59 |
| mysql      | cold-many |        26.42 |         26.27 |          27.1 |

<!-- /benchmark-table: v1.0.5-isolated-2026-11-08 -->

[Complete isolated results](../benchmarks/results/v1.0.5-isolated-2026-11-08/README.md) include
cart/outbox staging, state sizes, idle polling and all 57,600 operation latencies. The source is
released v1.0.5, with the recorded newer measurement harness overlaid and no runtime source edits.
The cart verifier checks quantities, totals and pending effect payloads outside timed intervals.

This run does not establish how 0.14.0 or 1.0.6 performs on that machine. A droplet size alone is
not a hardware identity: subsequent droplets may use different physical CPUs or storage. Compare
release variants within one controlled run, rather than calculating speedups across these tables.

## Historical datasets

The [historical appendix](benchmarks-history.md) preserves the busy M2 Ultra 1.0.5 run and the
August developer-laptop measurements. Those environments differ from each other and from the
isolated baselines. Their throughput ratios do not establish release regressions or speedups.

## Large state

The [isolated 1.0.5 state-size results](../benchmarks/results/v1.0.5-isolated-2026-11-08/README.md#sqlite-large-state)
measure whole-image persistence at four payload sizes. The
[August 0.14.3/0.14.4 comparison](benchmarks-history.md#large-state) records the earlier serialization
optimization. Each curve belongs to its measured release and host. The controlled counter comparison
uses small state; use a matching state-size workload for an application with larger actor images.

## Idle polling

The [isolated 1.0.5 idle CPU results](../benchmarks/results/v1.0.5-isolated-2026-11-08/README.md#sqlite-idle)
measure empty polling work. Historical 0.13.0/0.13.1
[wake-up latency measurements](benchmarks-history.md#idle-polling) record a separate experiment.
Neither is a wake-up latency measurement for 1.0.6.

## Virtualization cost

The [August Docker Desktop experiment](benchmarks-history.md#virtualization-cost) records that
machine's container boundary. The isolated cloud runs use Linux containers for PostgreSQL and MySQL
on the same VM as the Node client and workers, with bind-mounted data and host networking. Keep each
topology attached to its results.

## Scenarios

- `warm-hot`: all operations target one previously created identity.
- `warm-many`: operations rotate across 100 previously created identities.
- `cold-many`: every measured operation creates a new identity.
- `synchronous`: the actor method mutates state without yielding.
- `asynchronous`: the actor method yields through `setImmediate()` before the same mutation.
- `one-process`: four actor workers run in the caller's Node process.
- `four-processes`: four Node worker processes share the database.

The client durably sends each operation and polls for its committed result. Timing includes both
enqueue and result polling. Latency begins before durable enqueue and ends when the committed result is available. Throughput
uses the wall time for the measured batch. Percentiles use nearest rank. Defaults are 25 warmup
operations, 250 measured operations, and client concurrency 16.

## Run the harness

SQLite needs no service:

```bash
pnpm run benchmark -- --database sqlite
```

PostgreSQL and MySQL runs require a disposable database. The harness deletes benchmark rows but
leaves its uniquely prefixed empty tables for inspection.

```bash
SOLID_OBJECTS_POSTGRESQL_BENCHMARK_URL=postgresql://... \
  pnpm run benchmark -- --database postgresql

SOLID_OBJECTS_MYSQL_BENCHMARK_URL=mysql://... \
  pnpm run benchmark -- --database mysql
```

Use `--operations`, `--warmup`, `--concurrency`, and `--repetitions` to change the recorded dataset.
The standalone matrix defaults to three repetitions. Select `--workload counter` or `--workload cart-outbox`.
`--topologies`, `--shapes` and `--handlers` select focused scenarios. Controlled comparisons use
fresh processes for their outer rounds and retain a separate `comparison.json`; the full-matrix
summarizer continues to require every matrix scenario.
Redirect stdout to retain the JSON result; progress and runtime diagnostics go to stderr.

## Interpreting results

- A droplet size identifies a resource allocation; its physical CPU and storage can vary between
  instances. Controlled release comparisons keep all variants on one VM.
- Loopback SQL connections measure local databases. Application network latency and external effect
  delivery have their own boundaries.
- Filesystem caches, Node warmup, garbage collection, polling and scheduling affect timing. The
  reports retain sample ranges and operation latencies so variability stays visible.
- Hot identities serialize work. Additional workers increase parallelism across identities rather
  than making one actor process simultaneous operations.
- Counter operations use small state. Payload size and application logic change costs; match those
  workloads before using a result for capacity planning.
- SQLite journal mode and synchronization level are part of each measured configuration. WAL/NORMAL
  and WAL/FULL results carry different power-loss durability semantics.

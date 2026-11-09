# Benchmarks

The benchmark harness measures committed actor operations. It shows tradeoffs and catches large
regressions. It does not predict application capacity.

## Which measurements answer which question?

A package version is not a benchmark result. Read the release, hardware, database settings,
workload and harness together. Numbers from different environments do not establish a code
regression or speedup. In particular, dividing the August M5 figures by the November busy-Mac
figures is not a release comparison.

| Dataset                                                                                                     | Runtime measured                             | Environment                            | What it establishes                                                                 |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| [Controlled SQLite/PostgreSQL](../benchmarks/results/js-release-comparison-incomplete-2026-11-09/README.md) | 0.14.0, 1.0.5, 1.0.6                         | One dedicated c-8, November 9 UTC      | Complete backend plans from an incomplete matrix; MySQL failed its state check      |
| [Modern MySQL comparison](../benchmarks/results/js-mysql-release-comparison-2026-11-09/README.md)           | 1.0.5, 1.0.6                                 | Another dedicated c-8, November 9 UTC  | Complete same-host MySQL comparison; no ranking against the failed 0.14.0 condition |
| [Isolated baseline](../benchmarks/results/v1.0.5-isolated-2026-11-08/README.md)                             | 1.0.5                                        | Dedicated DigitalOcean c-8, November 8 | Reproducible single-version baseline, including raw samples and confirmed teardown  |
| [Shared workstation](../benchmarks/results/v1.0.5-2026-11-07/README.md)                                     | 1.0.5                                        | Busy M2 Ultra, November 7              | Historical observations; unsuitable for attributing a version regression            |
| [August archive](benchmarks-history.md#historical-august-0140-matrix)                                       | 0.14.0 (matrix), 0.14.3/0.14.4 (state sizes) | M5 developer laptop                    | Historical measurements in their original environments                              |

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
was stopped when the first SQLite round projected a matrix beyond its original three-hour guard.
The replacement fixed 500 operations before provisioning a fresh VM. All pilot reports and its stop
reason remain separate diagnostics; none is pooled into the replacement.

## Controlled releases: SQLite and PostgreSQL

The November 9 (UTC) experiment completed every planned SQLite and PostgreSQL condition on one
DigitalOcean c-8: five fresh-process rounds per variant, 500 measured operations after 100 warmups,
four worker processes, synchronous counters, three identity shapes, and client concurrency 1/16.
The table summarizes 70 complete reports and 105,000 measured operation latencies. Each report
starts fresh client/worker processes and measures warm-hot, warm-many, then cold-many in that order;
processes reset between reports.

The **parent matrix is incomplete**: 0.14.0's MySQL `warm-many` state check returned actor count 8,
expected 7, in round 3 at concurrency 1. Its cause is unconfirmed. All emitted reports and failure
diagnostics remain in the [failed parent archive](../benchmarks/results/js-release-comparison-incomplete-2026-11-09/README.md).
Only the complete predeclared backend plans are summarized; no rounds or versions are dropped within
a backend. `summarize-completed.mjs` derives every complete backend from the unchanged original plan,
and CI rechecks that exact scope. MySQL's incomplete prefix does not supply a three-release ranking.

All variants use the same Node 24.18.0, locked dependencies, SQL drivers, compiler and workload
harness. Released runtime source is unchanged. The explicit polling interval is 5 ms, idle ceiling
1,000 ms and pool limit 20 per runtime. Wake-up selection preserves release defaults: 0.14.0 uses
in-process signals with cross-process polling; 1.0.5/1.0.6 can select PostgreSQL notifications after a successful
probe. No Redis is configured. The experiment compares those defaults under common explicit options;
it does not isolate every runtime feature.

SQLite's 0.14.0/1.0.5 defaults are DELETE/FULL. Version 1.0.6 is measured as both WAL/NORMAL
(`v1.0.6-default`) and WAL/FULL (`v1.0.6-wal-full`). NORMAL can lose recent committed transactions
after power loss or an OS crash; FULL flushes each commit. Treat them as separate configurations.

These are medians of five samples, in committed operations per second. The
[complete-backend tables](../benchmarks/results/js-release-comparison-incomplete-2026-11-09/README.md)
retain minimum/maximum throughput, p50/p99 and every operation latency.

<!-- benchmark-table: js-release-comparison-incomplete-2026-11-09 -->

| Database   | Concurrency | Shape     | v0.14.0-default ops/s | v1.0.5-default ops/s | v1.0.6-default ops/s | v1.0.6-wal-full ops/s |
| ---------- | ----------: | --------- | --------------------: | -------------------: | -------------------: | --------------------: |
| sqlite     |           1 | warm-hot  |                 89.33 |               112.76 |               356.72 |                261.03 |
| sqlite     |           1 | warm-many |                 21.42 |                25.39 |                61.46 |                 61.22 |
| sqlite     |           1 | cold-many |                 14.86 |                16.57 |                39.46 |                 35.39 |
| sqlite     |          16 | warm-hot  |                168.43 |               166.35 |               549.58 |                343.35 |
| sqlite     |          16 | warm-many |                 50.27 |                48.49 |               103.72 |                 78.09 |
| sqlite     |          16 | cold-many |                 21.85 |                21.89 |                34.46 |                 30.56 |
| postgresql |           1 | warm-hot  |                 79.03 |                93.28 |                94.44 |                   n/a |
| postgresql |           1 | warm-many |                 21.63 |                35.41 |                35.64 |                   n/a |
| postgresql |           1 | cold-many |                 23.66 |                19.87 |                19.92 |                   n/a |
| postgresql |          16 | warm-hot  |                100.14 |                   80 |                80.82 |                   n/a |
| postgresql |          16 | warm-many |                 91.44 |               121.29 |               120.34 |                   n/a |
| postgresql |          16 | cold-many |                 19.72 |                19.38 |                19.27 |                   n/a |

<!-- /benchmark-table: js-release-comparison-incomplete-2026-11-09 -->

The results answer the earlier version questions:

- The old 25-fold SQLite decline is **not reproduced**. At concurrency 16, the matched hot-actor
  medians are 168.43 ops/s on 0.14.0 and 166.35 on 1.0.5, with overlapping sample ranges.
  Warm-many and cold-many are also close. At concurrency 1, 1.0.5 has higher median throughput in
  all three SQLite shapes. The August/busy-Mac ratios did not measure a code regression.
- PostgreSQL has workload-specific tradeoffs. At concurrency 16, the hot-actor median falls from
  100.14 to 80.00 ops/s (20.1%), while warm-many rises from 91.44 to 121.29 (32.6%). At concurrency 1,
  cold-many falls from 23.66 to 19.87 (16.0%). These are findings to investigate with profiling;
  this experiment does not attribute them to one particular feature.
- SQLite 1.0.6 improves the hot-actor median even with FULL synchronization: 343.35 versus 166.35
  ops/s at concurrency 16, about 2.06 times the throughput. WAL/NORMAL reaches 549.58, about
  3.30 times, with the stated durability tradeoff. State-size and application workloads need their
  own measurements.
- PostgreSQL 1.0.6 is close to 1.0.5 in these samples. Independent rebuilds show that their emitted
  JavaScript differs only in the SQLite adapter and version constant. Small PostgreSQL/MySQL
  differences are not evidence of a new 1.0.6 runtime optimization.

The host passed sustained CPU, storage and load quiet checks before every backend/round/concurrency
block, and version order rotated within rounds. Source, compiled-code and harness hashes were
independently reproduced. The archive was downloaded and verified, then the VM was confirmed deleted.
A recorded supervision handoff extended the controller window without restarting the collector or
changing the sampling plan. See [lifecycle and operator events](../benchmarks/results/js-release-comparison-incomplete-2026-11-09/operator-events.jsonl).

## Controlled releases: MySQL 1.0.5 and 1.0.6

The [fresh MySQL comparison](../benchmarks/results/js-mysql-release-comparison-2026-11-09/README.md)
completed all five rounds: 20 reports, 60 scenario samples and 30,000 measured operation latencies.
Its source, harness, Node, driver lock, four workers, 500-operation batches, 100 warmups, shapes and
concurrency settings match the recorded plan. State verification passed for every report. The
archive was downloaded, checksum-verified and the VM confirmed deleted.

This uses **another c-8 host**, an Intel Xeon Platinum 8280. Compare releases within this table;
its rates are not directly comparable to another droplet's database results. No samples from the
failed three-release MySQL prefix were reused. The 0.14.0 assertion still prevents a trustworthy
three-release MySQL ranking; its cause remains unconfirmed.

<!-- benchmark-table: js-mysql-release-comparison-2026-11-09 -->

| Database | Concurrency | Shape     | v1.0.5-default ops/s | v1.0.6-default ops/s |
| -------- | ----------: | --------- | -------------------: | -------------------: |
| mysql    |           1 | warm-hot  |                61.25 |                58.02 |
| mysql    |           1 | warm-many |                19.07 |                 19.6 |
| mysql    |           1 | cold-many |                15.87 |                15.41 |
| mysql    |          16 | warm-hot  |                46.63 |                47.21 |
| mysql    |          16 | warm-many |                75.62 |                76.44 |
| mysql    |          16 | cold-many |                16.86 |                16.88 |

<!-- /benchmark-table: js-mysql-release-comparison-2026-11-09 -->

At concurrency 16, throughput medians differ by at most 1.3% across the three shapes. At concurrency 1,
the hot-actor median is 61.25 ops/s for 1.0.5 and 58.02 for 1.0.6 (5.3% lower). Warm-many remains noisy:
its concurrency-one throughput spans 9.37–20.51 ops/s for 1.0.5 and 14.82–22.41 for 1.0.6. At concurrency
16 the median of within-sample warm-many p99 values is 1.90 seconds versus 2.95 seconds. Every sample
is retained in the full report; these tails deserve longer workload-specific measurements.

The relevant emitted runtime JavaScript is unchanged between these releases; only the unused SQLite
adapter and version constant differ. These observed timing differences do not isolate a
release-caused MySQL improvement or regression.

## Additional isolated 1.0.5 workloads

The [November 8 isolated baseline](../benchmarks/results/v1.0.5-isolated-2026-11-08/README.md)
retains all 57,600 latencies from counter/cart matrices, state-size and idle workloads. Its source
is released 1.0.5 with the recorded newer measurement harness overlaid. Cart verification checks
quantities, totals and pending effect payloads outside timed intervals.

That run used another c-8 instance and a different sampling plan. Its absolute rates do not form a
release comparison with the November 9 experiment. A droplet size alone does not identify physical
CPU or storage performance. Keep each workload's source, harness and environment attached.

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
  instances. Controlled release comparisons keep all variants on one VM. For each future release,
  rerun the previous release and candidate together on the new host; track their within-run ratios
  and sample ranges rather than comparing old absolute rates with a new droplet.
- Loopback SQL connections measure local databases. Application network latency and external effect
  delivery have their own boundaries.
- Filesystem caches, Node warmup, garbage collection, polling and scheduling affect timing. The
  reports retain sample ranges and operation latencies so variability stays visible. Small
  differences with overlapping sample ranges need longer follow-up measurements.
- Each 500-operation comparison sample has few observations in its extreme tail. The median of
  five within-sample p99 values is a diagnostic, not an application latency SLO estimate.
- Hot identities serialize work. Additional workers increase parallelism across identities rather
  than making one actor process simultaneous operations.
- Counter operations use small state. Payload size and application logic change costs; match those
  workloads before using a result for capacity planning.
- SQLite journal mode and synchronization level are part of each measured configuration. WAL/NORMAL
  and WAL/FULL results carry different power-loss durability semantics.

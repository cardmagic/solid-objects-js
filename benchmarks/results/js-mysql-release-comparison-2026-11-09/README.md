# Controlled MySQL comparison: 1.0.5 and 1.0.6

Measured November 9, 2026 (UTC) on one fresh disposable DigitalOcean `c-8` in `sfo3`: eight
dedicated vCPUs, 16 GiB RAM, Ubuntu 24.04, and Node.js 24.18.0. Every planned condition completed:
**20 reports, 60 scenario samples, and 30,000 operation latencies**. The archive was downloaded,
its checksum verified, and the VM confirmed deleted before publication.

[Exact sources, profile and lifecycle](run.json) · [Hardware/packages](host.txt) ·
[Quiet-period samples](quiet.jsonl) · [All samples and summaries](comparison.json) · [Collector log](collect.log).

This is a separate host from the failed three-release attempt. Its 0.14.0 MySQL state check returned
count 8, expected 7; the cause remains unconfirmed. No incomplete prefix, pilot or other host's
samples enter this dataset. This comparison measures 1.0.5 against 1.0.6 and supplies no MySQL
performance ranking against 0.14.0.

The released sources are `8975f6e2ad94c114f3638cea8f167956061a9bc3` (1.0.5) and
`e386867ef38cead441c2c0cc6a190266e74b98e3` (1.0.6). The common harness is
[`8a8d128c9e0516272263f869890a287489bee3ca`](https://github.com/cardmagic/solid-objects-js/commit/8a8d128c9e0516272263f869890a287489bee3ca),
and the cloud runner is `6b5c34bd35b574835bda8a003eda73eb125990f2`.
Both runtimes were built before measurement using one compiler, dependency lock and SQL driver set,
with unchanged runtime source. Source/harness hashes and compiled artifacts were independently
reproduced. The emitted JavaScript differs only in the unused SQLite adapter and version constant;
small timing differences here are not evidence of a new MySQL optimization in 1.0.6.

Each condition runs five fresh-process rounds of 500 measured counter operations after 100 warmups,
four actor worker processes, synchronous handlers, and client concurrency 1 or 16. Shapes are one
created identity (`warm-hot`), 100 created identities (`warm-many`), and a new identity per operation
(`cold-many`). Timing includes durable enqueue through the committed result, polled every millisecond.
Committed counts are checked outside timed batches. Each report starts fresh client/worker processes
and runs warm-hot, warm-many, then cold-many in that order; processes reset between reports. Active polling is 5 ms, the idle ceiling 1,000 ms,
and pools allow 20 connections per runtime. Effect/reminder workers are disabled; retention/dead-process cleanup
intervals are zero. No Redis is configured; MySQL uses polling across processes.

MySQL runs locally in the digest-pinned container with host networking and bind-mounted data.
Transaction-log and binlog flush settings are 1 for both variants. All actual versions and durability
settings are retained in the raw reports. The quiet gate runs before each round/concurrency block:
at least three minutes uptime, then 12 consecutive five-second samples with CPU <=5%, iowait <=1%,
steal <=1%, physical disk traffic <=1 MiB/s, and one-minute load/vCPU <=0.05. Release order rotates;
installation, builds, initialization, readiness, state checks and cleanup are outside the timers.

Every sample is retained. Statistics are calculated within samples and then summarized by median,
with throughput ranges visible; operation latencies are not pooled. Tail percentiles from 500
operations are diagnostics, and small overlapping differences need longer follow-up. These results
apply to local SQL counters with small state. They do not measure cart/effect delivery, large actor
images, cross-host networks or application capacity. Another c-8 can have different physical CPU or
storage; release comparisons belong to the variants on this one VM.

| Database | Variant        | Concurrency | Shape     | Samples | Median ops/s | Min ops/s | Max ops/s | Median p50 ms | Median p99 ms |
| -------- | -------------- | ----------: | --------- | ------: | -----------: | --------: | --------: | ------------: | ------------: |
| mysql    | v1.0.5-default |           1 | warm-hot  |       5 |        61.25 |     58.37 |     62.65 |         17.98 |         23.35 |
| mysql    | v1.0.5-default |           1 | warm-many |       5 |        19.07 |      9.37 |     20.51 |         34.48 |        668.84 |
| mysql    | v1.0.5-default |           1 | cold-many |       5 |        15.87 |     15.55 |     16.35 |          52.1 |        175.94 |
| mysql    | v1.0.6-default |           1 | warm-hot  |       5 |        58.02 |     55.67 |     58.58 |         19.16 |         24.24 |
| mysql    | v1.0.6-default |           1 | warm-many |       5 |         19.6 |     14.82 |     22.41 |         33.17 |        546.49 |
| mysql    | v1.0.6-default |           1 | cold-many |       5 |        15.41 |     15.13 |     15.85 |         55.52 |        171.78 |
| mysql    | v1.0.5-default |          16 | warm-hot  |       5 |        46.63 |     45.44 |     47.45 |        342.03 |        419.84 |
| mysql    | v1.0.5-default |          16 | warm-many |       5 |        75.62 |      62.8 |     87.72 |        119.73 |        1896.9 |
| mysql    | v1.0.5-default |          16 | cold-many |       5 |        16.86 |     16.76 |     17.07 |        962.37 |       1389.36 |
| mysql    | v1.0.6-default |          16 | warm-hot  |       5 |        47.21 |     44.37 |     48.46 |        341.09 |         404.3 |
| mysql    | v1.0.6-default |          16 | warm-many |       5 |        76.44 |     64.28 |     77.26 |        114.79 |       2951.14 |
| mysql    | v1.0.6-default |          16 | cold-many |       5 |        16.88 |     16.79 |     17.12 |        959.96 |       1377.19 |

# Incomplete matrix: completed SQLite and PostgreSQL comparisons

The three-release matrix planned 100 reports. It stopped after 83 complete reports when
**0.14.0 on MySQL**, round 3, concurrency 1, failed the `warm-many` committed-state check:
actor count **8**, expected **7**. The underlying cause is unconfirmed. The collector exited on
that assertion; the parent experiment remains **failed**. All emitted reports and the failed
condition's diagnostics are retained. The archive checksum was verified and the VM confirmed
destroyed on November 9, 2026 (UTC).

Only the fully completed, predeclared **SQLite and PostgreSQL** plans are summarized here:
all versions/configurations, both concurrency levels, all three shapes, and all five rounds.
Those comparisons contain **70 reports, 210 scenario samples, and 105,000 operation latencies**.
The summary automatically includes every completed backend and cannot select individual rounds
or variants. MySQL's 13 complete prefix reports remain diagnostics; they do not supply a
three-release throughput comparison. No samples are pooled with another machine or attempt.

One disposable DigitalOcean `c-8` in `sfo3`: eight dedicated vCPUs, 16 GiB RAM, Ubuntu 24.04,
and Node.js 24.18.0. [Original failed run and full plan](run.json) · [Hardware](host.txt) ·
[Quiet samples](quiet.jsonl) · [Derived complete-backend summary](comparison.json) ·
[Workload assertion and collector log](collect.log).

After 82 reports, between timed blocks, supervision was handed off because quiet waits projected
completion close to the original three-hour guard. The same collector continued on the same VM
without restarting workloads or changing the plan. The recovery controller selected a 90-minute
remaining window and downloaded and verified the archive after the workload assertion, then deleted
the VM. [Operator events](operator-events.jsonl) and `run.json` preserve the intervention and exact
recovery-script hash. Future runner revisions allow four hours for the full plan and quiet waits.

Released sources: `0.14.0` (`456d8ba1350dd22d3a2d669631631d8a22472db5`),
`1.0.5` (`8975f6e2ad94c114f3638cea8f167956061a9bc3`), and
`1.0.6` (`e386867ef38cead441c2c0cc6a190266e74b98e3`). The common workload harness is
[`8a8d128c9e0516272263f869890a287489bee3ca`](https://github.com/cardmagic/solid-objects-js/commit/8a8d128c9e0516272263f869890a287489bee3ca).
The actual cloud controller is `e24907aa919a57989a00a2486639c7e754d71678`.
All variants were built before measurement with the same compiler, dependency lock and SQL drivers.
Runtime source was unchanged. Source and harness hashes were independently reproduced from Git;
compiled-code hashes were independently reproduced with the recorded toolchain.

Every condition uses five fresh-process rounds of 500 measured counter operations after 100
warmups, four actor worker processes, synchronous handlers, and client concurrency 1 or 16.
`warm-hot` uses one created identity, `warm-many` uses 100 created identities, and `cold-many`
creates an identity per operation. Timing starts before durable enqueue and ends at the committed
result, polled every millisecond. State checks run outside the timed batches. Each report starts
fresh client/worker processes and runs warm-hot, warm-many, then cold-many in that order; processes reset between reports.

Active polling is 5 ms, the idle ceiling is 1,000 ms, and SQL pools allow 20 connections per runtime.
Effect and reminder workers are disabled; retention and dead-process cleanup intervals are zero. Other defaults
belong to each release: 0.14.0 uses in-process signals with cross-process polling; 1.0.5/1.0.6 can
automatically select PostgreSQL notifications after a successful probe. No Redis is configured.
This compares released defaults under common explicit options, without isolating every feature.

SQLite variants are labeled separately: 0.14.0/1.0.5 DELETE/FULL, 1.0.6 WAL/NORMAL defaults, and
1.0.6 WAL/FULL. NORMAL can lose recent committed transactions on power loss or an OS crash; FULL
flushes each commit. Comparing WAL/FULL with WAL/NORMAL shows the synchronization tradeoff within
1.0.6. PostgreSQL and MySQL use the same respective durability settings across all releases.

The collector runs one backend at a time. Before each database/round/concurrency block it requires
12 consecutive five-second quiet samples after at least three minutes of uptime: CPU <=5%,
iowait <=1%, steal <=1%, physical disk traffic <=1 MiB/s, and one-minute load/vCPU <=0.05.
Versions rotate order within each round. Builds, database initialization, quiet waits, verification
and teardown are outside the timed intervals. Every completed sample is retained; none is selected
by speed. The incomplete 1,000-operation feasibility pilot remains a separate diagnostic dataset.

Statistics are calculated within each sample, then summarized by median; latencies are not pooled.
The table retains minimum and maximum throughput and the median of each sample's p50/p99.
Five short samples can identify large differences, while small overlapping differences and extreme
tail behavior need longer follow-up. These are local SQL counter workloads with small state;
cart/effect delivery, large-state behavior, cross-host networks and application capacity are outside
this comparison. A future droplet of the same size can have different physical CPU/storage, so
release ratios belong to the variants on this one VM.

| Database   | Variant         | Concurrency | Shape     | Samples | Median ops/s | Min ops/s | Max ops/s | Median p50 ms | Median p99 ms |
| ---------- | --------------- | ----------: | --------- | ------: | -----------: | --------: | --------: | ------------: | ------------: |
| sqlite     | v0.14.0-default |           1 | warm-hot  |       5 |        89.33 |      86.9 |     90.85 |         11.05 |         19.62 |
| sqlite     | v0.14.0-default |           1 | warm-many |       5 |        21.42 |     10.71 |     22.49 |         31.05 |           427 |
| sqlite     | v0.14.0-default |           1 | cold-many |       5 |        14.86 |     11.89 |     15.24 |         51.07 |         330.5 |
| sqlite     | v1.0.5-default  |           1 | warm-hot  |       5 |       112.76 |    107.36 |    117.04 |           7.5 |         18.22 |
| sqlite     | v1.0.5-default  |           1 | warm-many |       5 |        25.39 |     16.83 |     28.58 |          23.8 |        596.72 |
| sqlite     | v1.0.5-default  |           1 | cold-many |       5 |        16.57 |     13.17 |     18.62 |          38.6 |        388.29 |
| sqlite     | v1.0.6-default  |           1 | warm-hot  |       5 |       356.72 |    337.97 |    369.63 |          2.88 |          7.69 |
| sqlite     | v1.0.6-default  |           1 | warm-many |       5 |        61.46 |     40.65 |      73.3 |         10.04 |        139.51 |
| sqlite     | v1.0.6-default  |           1 | cold-many |       5 |        39.46 |     37.55 |     45.04 |         20.63 |        135.36 |
| sqlite     | v1.0.6-wal-full |           1 | warm-hot  |       5 |       261.03 |    250.82 |     262.8 |          3.37 |           8.2 |
| sqlite     | v1.0.6-wal-full |           1 | warm-many |       5 |        61.22 |     41.24 |     71.34 |         10.17 |         93.54 |
| sqlite     | v1.0.6-wal-full |           1 | cold-many |       5 |        35.39 |     33.56 |     36.72 |         22.64 |        140.53 |
| sqlite     | v0.14.0-default |          16 | warm-hot  |       5 |       168.43 |    158.71 |    169.87 |         97.02 |        158.71 |
| sqlite     | v0.14.0-default |          16 | warm-many |       5 |        50.27 |      47.1 |     52.55 |        294.29 |        784.77 |
| sqlite     | v0.14.0-default |          16 | cold-many |       5 |        21.85 |     21.48 |     23.69 |        659.26 |       1985.07 |
| sqlite     | v1.0.5-default  |          16 | warm-hot  |       5 |       166.35 |    157.78 |    171.25 |          95.2 |        175.38 |
| sqlite     | v1.0.5-default  |          16 | warm-many |       5 |        48.49 |     43.97 |     53.89 |        279.55 |         864.1 |
| sqlite     | v1.0.5-default  |          16 | cold-many |       5 |        21.89 |     20.87 |     24.56 |        679.31 |       1876.46 |
| sqlite     | v1.0.6-default  |          16 | warm-hot  |       5 |       549.58 |    527.13 |    580.94 |         28.72 |         52.69 |
| sqlite     | v1.0.6-default  |          16 | warm-many |       5 |       103.72 |     95.05 |    110.23 |        115.26 |        700.84 |
| sqlite     | v1.0.6-default  |          16 | cold-many |       5 |        34.46 |     31.82 |      38.4 |        353.96 |        1193.3 |
| sqlite     | v1.0.6-wal-full |          16 | warm-hot  |       5 |       343.35 |    323.86 |    359.86 |         45.56 |          85.2 |
| sqlite     | v1.0.6-wal-full |          16 | warm-many |       5 |        78.09 |     63.28 |      80.2 |        179.51 |         715.3 |
| sqlite     | v1.0.6-wal-full |          16 | cold-many |       5 |        30.56 |     30.19 |     32.42 |        432.82 |       1381.16 |
| postgresql | v0.14.0-default |           1 | warm-hot  |       5 |        79.03 |     78.08 |     81.54 |         12.72 |         16.97 |
| postgresql | v0.14.0-default |           1 | warm-many |       5 |        21.63 |     15.94 |      29.7 |         23.99 |        591.83 |
| postgresql | v0.14.0-default |           1 | cold-many |       5 |        23.66 |     21.28 |     24.66 |         35.41 |        147.08 |
| postgresql | v1.0.5-default  |           1 | warm-hot  |       5 |        93.28 |     91.24 |     96.07 |         10.44 |         16.61 |
| postgresql | v1.0.5-default  |           1 | warm-many |       5 |        35.41 |     34.81 |     36.48 |         26.73 |         52.51 |
| postgresql | v1.0.5-default  |           1 | cold-many |       5 |        19.87 |     19.53 |     20.53 |         40.75 |        157.76 |
| postgresql | v1.0.6-default  |           1 | warm-hot  |       5 |        94.44 |     92.57 |     96.74 |         10.31 |         16.35 |
| postgresql | v1.0.6-default  |           1 | warm-many |       5 |        35.64 |     34.02 |     36.38 |         26.52 |          52.6 |
| postgresql | v1.0.6-default  |           1 | cold-many |       5 |        19.92 |     19.18 |     20.49 |         42.07 |        149.17 |
| postgresql | v0.14.0-default |          16 | warm-hot  |       5 |       100.14 |     99.34 |    107.66 |        159.11 |        189.52 |
| postgresql | v0.14.0-default |          16 | warm-many |       5 |        91.44 |     65.61 |    121.22 |         86.34 |       2481.38 |
| postgresql | v0.14.0-default |          16 | cold-many |       5 |        19.72 |     19.34 |     20.03 |        808.33 |       1221.76 |
| postgresql | v1.0.5-default  |          16 | warm-hot  |       5 |           80 |     76.32 |     81.82 |        200.92 |         236.9 |
| postgresql | v1.0.5-default  |          16 | warm-many |       5 |       121.29 |    112.99 |    121.84 |         83.43 |       1022.67 |
| postgresql | v1.0.5-default  |          16 | cold-many |       5 |        19.38 |     18.83 |     19.43 |        827.63 |       1270.95 |
| postgresql | v1.0.6-default  |          16 | warm-hot  |       5 |        80.82 |      77.4 |     82.73 |        199.16 |        228.81 |
| postgresql | v1.0.6-default  |          16 | warm-many |       5 |       120.34 |    114.34 |    123.01 |         84.37 |       1022.72 |
| postgresql | v1.0.6-default  |          16 | cold-many |       5 |        19.27 |      18.9 |     19.73 |        829.52 |       1262.72 |

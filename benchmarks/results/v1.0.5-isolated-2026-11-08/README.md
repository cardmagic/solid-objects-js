# Isolated version 1.0.5 baseline

Measured November 8, 2026 on a disposable DigitalOcean `c-8` in `sfo3`: 8 dedicated vCPUs,
16 GiB RAM, Ubuntu 24.04, and Node.js 24.18.0. All six SQL matrices, 12 state-size rows and
three idle rows passed, retaining **57,600 individual operation latencies**. Results were downloaded
and the droplet was confirmed destroyed.

Runtime: `8975f6e2ad94c114f3638cea8f167956061a9bc3` (`v1.0.5`).
Harness: `57665ddfacfd44a83aa9cf048722012a22407fbc`. Runner: `144dc71760a1aaf0d709a2a731c4cf046a977c0a`.
The controller recovered after a terminal interruption, downloaded the existing collector output
without restarting any workloads, and confirmed teardown.

[Run, hashes, profile and lifecycle](run.json) · [Hardware and packages](host.txt) ·
[Quiet-period samples](quiet.jsonl) · [Collector diagnostics](collect.log).

Source and harness hashes were independently checked against their Git revisions. The compiled
runtime hash also matches the unchanged released build used by the previous dataset. The generated
summary was independently reproduced from all eight raw reports before adding this environment note.
Cart checks verified quantities, prices, totals and pending effect payloads after the timed batches.

This is a single-version baseline, not evidence of a release-to-release regression or speedup.
MySQL's multi-process scenarios use polling-only wake-up, with a 5 ms active interval and 1,000 ms
idle ceiling; those runtime diagnostics remain in the log. This is a separate environment from the
older busy-workstation measurements. Use the archived profile and host metadata when comparing runs.
The installed Docker/containerd/runc versions in `host.txt` are now pinned in the reusable profiles.

Matrix and state-size statistics are medians across the samples recorded in each report. Idle rows are single timed samples per interval. Percentiles are calculated within each sample; samples are not pooled. Raw reports retain every measured operation latency.

Source: [8975f6e2ad94c114f3638cea8f167956061a9bc3](https://github.com/cardmagic/solid-objects-js/commit/8975f6e2ad94c114f3638cea8f167956061a9bc3). Runtime source is unchanged from that commit; the benchmark harness is overlaid.

Runtime: v24.18.0; linux 6.8.0-147-generic; Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz; 8 logical CPUs; 15.617000579833984 GiB RAM.

Drivers: pg 8.23.0, mysql2 3.23.3.

Runtime source SHA-256: eb7d3285a5fbd457ea346c4cab3a970ce23082e9b5ab15f9d4f9f716aff67af0

Built runtime SHA-256: 0f8c875c4a113c0ea8d9ec8f59a254046b363d670fa9db332b2370a4f434d829

Harness SHA-256: 3621a245b2019d3f0dfd3cf81efef0ac1643903b088479c285a3180a78c4b285

## sqlite counter

Raw report: [sqlite-counter.json](sqlite-counter.json)

Database version: 3.53.1. Durability settings: {"journalMode":"delete","synchronous":2}.

Samples per scenario: 3.

| Topology       | Shape     | Handler      |  ops/s | p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | -----: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |  165.1 | 100.58 |  116.08 |  116.41 |
| one-process    | warm-hot  | asynchronous | 132.84 | 119.71 |  127.39 |  134.87 |
| one-process    | warm-many | synchronous  | 171.86 |  33.99 |  627.47 |  926.67 |
| one-process    | warm-many | asynchronous | 113.65 |  72.35 |  500.21 |  1402.6 |
| one-process    | cold-many | synchronous  |  66.46 | 234.08 |  306.84 |  318.28 |
| one-process    | cold-many | asynchronous |  42.38 | 377.78 |  406.47 |  423.93 |
| four-processes | warm-hot  | synchronous  | 198.83 |  81.43 |   118.2 |  136.26 |
| four-processes | warm-hot  | asynchronous | 207.07 |  77.49 |   115.2 |  121.21 |
| four-processes | warm-many | synchronous  |  69.08 | 210.39 |  443.02 |  480.08 |
| four-processes | warm-many | asynchronous |  50.04 | 263.25 |   744.9 |  829.54 |
| four-processes | cold-many | synchronous  |  34.78 | 426.64 |  919.46 | 1208.52 |
| four-processes | cold-many | asynchronous |  24.98 | 573.39 | 1169.17 |  1539.8 |

## sqlite cart-outbox

Raw report: [sqlite-cart-outbox.json](sqlite-cart-outbox.json)

Database version: 3.53.1. Durability settings: {"journalMode":"delete","synchronous":2}.

Samples per scenario: 3.

| Topology       | Shape     | Handler      |  ops/s | p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | -----: | ------: | ------: |
| one-process    | warm-hot  | synchronous  | 153.07 | 107.96 |  121.35 |  124.84 |
| one-process    | warm-hot  | asynchronous | 124.58 | 128.36 |  140.58 |  143.63 |
| one-process    | warm-many | synchronous  | 157.44 |  36.72 |  666.82 | 1007.61 |
| one-process    | warm-many | asynchronous | 105.35 |  75.31 |  579.67 | 1491.65 |
| one-process    | cold-many | synchronous  |   63.8 | 243.99 |  319.97 |   342.5 |
| one-process    | cold-many | asynchronous |  41.23 | 386.94 |  442.96 |  458.57 |
| four-processes | warm-hot  | synchronous  |  180.4 |  89.96 |  132.56 |  157.47 |
| four-processes | warm-hot  | asynchronous | 183.09 |  83.86 |  128.81 |  167.05 |
| four-processes | warm-many | synchronous  |   70.8 | 183.74 |  502.47 |  907.62 |
| four-processes | warm-many | asynchronous |  44.42 |  243.2 |  935.45 | 1741.44 |
| four-processes | cold-many | synchronous  |  34.43 | 380.67 |  835.73 |  972.02 |
| four-processes | cold-many | asynchronous |  24.13 |  594.5 | 1167.18 | 1313.41 |

## postgresql counter

Raw report: [postgresql-counter.json](postgresql-counter.json)

Database version: 16.15 (Debian 16.15-1.pgdg12+2). Durability settings: {"fsync":"on","synchronousCommit":"on"}.

Samples per scenario: 3.

| Topology       | Shape     | Handler      |  ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |  60.77 |  266.16 |  299.65 |  313.36 |
| one-process    | warm-hot  | asynchronous |  60.46 |  265.64 |   310.5 |  321.61 |
| one-process    | warm-many | synchronous  |  71.54 |  149.96 |  442.55 | 2220.87 |
| one-process    | warm-many | asynchronous |   26.5 |  320.22 | 2131.21 | 6041.98 |
| one-process    | cold-many | synchronous  |  13.02 | 1193.22 | 1616.36 | 1729.23 |
| one-process    | cold-many | asynchronous |  11.26 | 1427.38 |  1643.5 | 1684.94 |
| four-processes | warm-hot  | synchronous  |  97.05 |  165.53 |  186.98 |   217.7 |
| four-processes | warm-hot  | asynchronous |  99.86 |   160.8 |  176.71 |  190.55 |
| four-processes | warm-many | synchronous  | 142.57 |    71.4 |  212.98 |  910.68 |
| four-processes | warm-many | asynchronous |  63.82 |  161.89 |   513.9 | 2443.56 |
| four-processes | cold-many | synchronous  |   28.5 |  553.53 |  726.76 |  744.74 |
| four-processes | cold-many | asynchronous |  16.82 |   937.7 | 1131.95 | 1163.86 |

## postgresql cart-outbox

Raw report: [postgresql-cart-outbox.json](postgresql-cart-outbox.json)

Database version: 16.15 (Debian 16.15-1.pgdg12+2). Durability settings: {"fsync":"on","synchronousCommit":"on"}.

Samples per scenario: 3.

| Topology       | Shape     | Handler      |  ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |     56 |  284.39 |  333.58 |  377.87 |
| one-process    | warm-hot  | asynchronous |  53.48 |  305.88 |  332.98 |  362.05 |
| one-process    | warm-many | synchronous  |   67.3 |  155.05 |  389.75 |    2339 |
| one-process    | warm-many | asynchronous |  27.66 |  311.25 | 2129.04 |  5778.2 |
| one-process    | cold-many | synchronous  |  12.72 | 1277.95 | 1585.77 | 1668.12 |
| one-process    | cold-many | asynchronous |  11.56 | 1319.98 |  1809.2 | 1864.93 |
| four-processes | warm-hot  | synchronous  |  89.44 |  180.01 |  199.25 |  235.47 |
| four-processes | warm-hot  | asynchronous |  94.35 |  166.63 |  191.41 |  220.84 |
| four-processes | warm-many | synchronous  | 135.53 |   83.82 |   213.6 |  937.14 |
| four-processes | warm-many | asynchronous |  62.66 |  152.62 |  858.77 | 2503.39 |
| four-processes | cold-many | synchronous  |  27.96 |  570.59 |  733.49 |  777.43 |
| four-processes | cold-many | asynchronous |  16.86 |  955.57 | 1087.15 | 1123.44 |

## mysql counter

Raw report: [mysql-counter.json](mysql-counter.json)

Database version: 8.4.13. Durability settings: {"innodbFlushLogAtTrxCommit":1,"syncBinlog":1}.

Samples per scenario: 3.

| Topology       | Shape     | Handler      | ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | ----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  | 24.77 |  643.24 |  760.61 |  819.97 |
| one-process    | warm-hot  | asynchronous | 24.42 |  652.95 |  714.12 |  747.43 |
| one-process    | warm-many | synchronous  | 26.22 |  393.59 |  1068.4 |  6169.1 |
| one-process    | warm-many | asynchronous | 12.39 |  548.22 | 2764.44 | 11916.5 |
| one-process    | cold-many | synchronous  |   7.2 | 2332.38 | 2895.65 | 2996.86 |
| one-process    | cold-many | asynchronous |  7.11 | 2251.64 | 2500.67 | 2572.48 |
| four-processes | warm-hot  | synchronous  | 71.23 |  222.45 |  264.38 |  297.66 |
| four-processes | warm-hot  | asynchronous | 70.03 |  230.22 |   252.8 |  272.75 |
| four-processes | warm-many | synchronous  | 79.46 |  105.16 |  405.85 | 1512.56 |
| four-processes | warm-many | asynchronous | 55.66 |  177.55 |     480 | 2803.78 |
| four-processes | cold-many | synchronous  | 26.42 |  603.02 |  781.28 |  812.11 |
| four-processes | cold-many | asynchronous | 16.39 |     972 | 1092.31 | 1115.39 |

## mysql cart-outbox

Raw report: [mysql-cart-outbox.json](mysql-cart-outbox.json)

Database version: 8.4.13. Durability settings: {"innodbFlushLogAtTrxCommit":1,"syncBinlog":1}.

Samples per scenario: 3.

| Topology       | Shape     | Handler      | ops/s |  p50 ms |  p95 ms |   p99 ms |
| -------------- | --------- | ------------ | ----: | ------: | ------: | -------: |
| one-process    | warm-hot  | synchronous  | 23.34 |  682.92 |  759.49 |   816.43 |
| one-process    | warm-hot  | asynchronous | 22.81 |  729.24 |  782.57 |    810.4 |
| one-process    | warm-many | synchronous  | 28.95 |  372.74 |  999.97 |  5381.73 |
| one-process    | warm-many | asynchronous | 12.29 |   649.2 | 2799.66 | 11887.85 |
| one-process    | cold-many | synchronous  |  7.45 | 2268.93 | 2877.41 |  2940.71 |
| one-process    | cold-many | asynchronous |  7.14 | 2260.34 | 2479.84 |  2512.49 |
| four-processes | warm-hot  | synchronous  | 69.26 |   231.7 |  259.93 |   304.56 |
| four-processes | warm-hot  | asynchronous | 60.27 |  255.12 |   327.5 |   351.57 |
| four-processes | warm-many | synchronous  | 83.91 |   96.61 |  457.87 |  2089.58 |
| four-processes | warm-many | asynchronous | 54.56 |  173.16 |  762.73 |  2983.36 |
| four-processes | cold-many | synchronous  | 26.71 |  582.67 |  802.85 |   831.75 |
| four-processes | cold-many | asynchronous | 16.45 |  977.73 | 1083.08 |  1158.51 |

## sqlite large state

Raw report: [sqlite-large-state.json](sqlite-large-state.json)

Database version: 3.53.1. Durability settings: "see methodology".

Samples per scenario: 3.

| Payload bytes | Persisted state bytes |  ops/s | p50 ms | p95 ms | p99 ms |
| ------------: | --------------------: | -----: | -----: | -----: | -----: |
|             0 |                    26 | 227.51 |   4.37 |   4.66 |   5.29 |
|         16384 |                 16410 | 214.56 |   4.58 |   5.12 |   5.97 |
|        131072 |                131098 | 142.47 |   6.72 |   7.06 |  18.28 |
|       1048576 |               1048602 |  45.13 |  21.12 |  27.57 |  29.21 |

## sqlite idle

Raw report: [sqlite-idle.json](sqlite-idle.json)

Database version: 3.53.1. Durability settings: "see methodology".

| Fast interval ms | Idle ceiling ms | polls/s | CPU percent |
| ---------------: | --------------: | ------: | ----------: |
|               20 |            1000 |   3.999 |       0.204 |
|              100 |            1000 |   3.999 |       0.202 |
|              500 |            1000 |   3.999 |        0.17 |

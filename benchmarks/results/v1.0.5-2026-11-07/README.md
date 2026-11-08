# Version 1.0.5 benchmark results

Matrix and state-size statistics are medians across three separate samples. Idle rows are single
timed samples per interval. Percentiles are calculated within each sample; samples are not pooled.
Raw reports retain every measured operation latency.

Source:
[8975f6e2ad94c114f3638cea8f167956061a9bc3](https://github.com/cardmagic/solid-objects-js/commit/8975f6e2ad94c114f3638cea8f167956061a9bc3).
Runtime source is unchanged from that commit; the benchmark harness is overlaid.

Runtime: v24.18.0; darwin 27.2.0; Apple M2 Ultra; 24 logical CPUs; 64 GiB RAM.

Drivers: pg 8.23.0, mysql2 3.23.3.

Runtime source SHA-256: eb7d3285a5fbd457ea346c4cab3a970ce23082e9b5ab15f9d4f9f716aff67af0

Built runtime SHA-256: 0f8c875c4a113c0ea8d9ec8f59a254046b363d670fa9db332b2370a4f434d829

Harness SHA-256: 34b1fa0bed8b0772682126274879d3b3774daa0de550b4075b443160529548d2

## sqlite counter

Raw report: [sqlite-counter.json](sqlite-counter.json)

Database version: 3.53.1. Durability settings: {"journalMode":"delete","synchronous":2}.

| Topology       | Shape     | Handler      | ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | ----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  | 32.95 |   340.3 | 1106.85 |  1288.6 |
| one-process    | warm-hot  | asynchronous | 18.25 |  548.15 | 2513.27 | 2874.31 |
| one-process    | warm-many | synchronous  | 44.76 |     141 | 3493.72 | 4281.41 |
| one-process    | warm-many | asynchronous | 46.64 |  147.56 |  990.89 | 3544.04 |
| one-process    | cold-many | synchronous  | 35.63 |  406.77 |  625.46 |  682.98 |
| one-process    | cold-many | asynchronous | 25.87 |   415.9 | 2150.47 | 2519.81 |
| four-processes | warm-hot  | synchronous  | 20.69 |  733.52 | 1595.35 | 1754.31 |
| four-processes | warm-hot  | asynchronous | 35.66 |  365.32 | 1612.17 | 1663.53 |
| four-processes | warm-many | synchronous  | 13.51 |  818.09 | 3205.47 |  6056.1 |
| four-processes | warm-many | asynchronous | 17.78 |  830.69 | 1854.98 | 2912.31 |
| four-processes | cold-many | synchronous  |  5.77 |  2497.5 | 5538.34 | 6346.58 |
| four-processes | cold-many | asynchronous |  9.05 | 1602.43 | 4070.13 | 4578.57 |

## sqlite cart-outbox

Raw report: [sqlite-cart-outbox.json](sqlite-cart-outbox.json)

Database version: 3.53.1. Durability settings: {"journalMode":"delete","synchronous":2}.

| Topology       | Shape     | Handler      |  ops/s | p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | -----: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |  88.77 |  174.2 |  259.59 |  273.36 |
| one-process    | warm-hot  | asynchronous |  73.82 | 203.19 |  289.39 |  338.37 |
| one-process    | warm-many | synchronous  |  57.96 |  96.81 | 1828.62 |  2633.2 |
| one-process    | warm-many | asynchronous |  48.89 |  142.8 |  1181.2 | 2918.72 |
| one-process    | cold-many | synchronous  |  44.63 | 344.71 |   456.8 |  519.07 |
| one-process    | cold-many | asynchronous |  42.12 | 377.46 |  445.05 |  462.28 |
| four-processes | warm-hot  | synchronous  | 106.27 | 147.92 |  205.03 |  283.86 |
| four-processes | warm-hot  | asynchronous | 108.34 | 152.19 |  230.56 |  280.85 |
| four-processes | warm-many | synchronous  |  56.87 | 264.62 |   454.1 |  588.05 |
| four-processes | warm-many | asynchronous |  44.65 |  336.6 |  856.59 | 1309.15 |
| four-processes | cold-many | synchronous  |   35.4 | 393.17 |  1037.9 | 1286.45 |
| four-processes | cold-many | asynchronous |  25.52 | 644.32 | 1104.37 | 1578.75 |

## postgresql counter

Raw report: [postgresql-counter.json](postgresql-counter.json)

Database version: 16.15 (Homebrew). Durability settings: {"fsync":"on","synchronousCommit":"on"}.

| Topology       | Shape     | Handler      |  ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |  91.69 |  174.02 |  200.44 |  206.95 |
| one-process    | warm-hot  | asynchronous |  89.22 |  180.73 |  198.96 |  204.97 |
| one-process    | warm-many | synchronous  | 106.65 |   86.25 |  277.81 | 1182.25 |
| one-process    | warm-many | asynchronous |  45.07 |  205.72 | 1262.45 | 3622.06 |
| one-process    | cold-many | synchronous  |  18.36 |  878.18 | 1208.22 | 1274.63 |
| one-process    | cold-many | asynchronous |  12.77 | 1256.26 | 1576.09 | 1696.15 |
| four-processes | warm-hot  | synchronous  |  88.84 |  160.37 |  275.92 |  293.19 |
| four-processes | warm-hot  | asynchronous |  95.73 |  168.13 |  285.77 |   303.8 |
| four-processes | warm-many | synchronous  | 146.88 |   70.92 |  176.45 | 1103.97 |
| four-processes | warm-many | asynchronous |  46.24 |  199.02 | 1323.69 | 3443.67 |
| four-processes | cold-many | synchronous  |  20.25 |  808.09 | 1069.78 | 1140.48 |
| four-processes | cold-many | asynchronous |   14.3 | 1116.27 | 1415.08 | 1516.61 |

## postgresql cart-outbox

Raw report: [postgresql-cart-outbox.json](postgresql-cart-outbox.json)

Database version: 16.15 (Homebrew). Durability settings: {"fsync":"on","synchronousCommit":"on"}.

| Topology       | Shape     | Handler      |  ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |  79.27 |  200.34 |  255.44 |  269.94 |
| one-process    | warm-hot  | asynchronous |  83.25 |  182.17 |  271.93 |  305.66 |
| one-process    | warm-many | synchronous  |  92.08 |  100.05 |  347.15 | 1641.46 |
| one-process    | warm-many | asynchronous |   36.7 |  239.68 |  1483.2 | 4289.36 |
| one-process    | cold-many | synchronous  |  16.42 |  908.61 | 1487.86 |  1545.6 |
| one-process    | cold-many | asynchronous |  13.28 | 1187.75 | 1555.95 | 1604.23 |
| four-processes | warm-hot  | synchronous  |  99.15 |  159.81 |  227.97 |  244.67 |
| four-processes | warm-hot  | asynchronous |  94.67 |   171.1 |  250.35 |  280.77 |
| four-processes | warm-many | synchronous  | 107.12 |   93.49 |  253.75 |  1307.5 |
| four-processes | warm-many | asynchronous |  54.03 |  204.28 | 1122.33 | 2955.29 |
| four-processes | cold-many | synchronous  |  21.56 |   651.8 |   979.4 | 1056.95 |
| four-processes | cold-many | asynchronous |  14.91 | 1033.01 | 1350.38 | 1419.35 |

## mysql counter

Raw report: [mysql-counter.json](mysql-counter.json)

Database version: 26.10.0. Durability settings: {"innodbFlushLogAtTrxCommit":1,"syncBinlog":1}.

| Topology       | Shape     | Handler      |  ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | -----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |  39.86 |  401.33 |  492.99 |  517.16 |
| one-process    | warm-hot  | asynchronous |  39.47 |  407.02 |  512.31 |  533.98 |
| one-process    | warm-many | synchronous  |  48.57 |  222.09 |  611.71 |  3259.2 |
| one-process    | warm-many | asynchronous |  18.98 |  484.81 | 2621.75 | 8654.16 |
| one-process    | cold-many | synchronous  |  10.09 |  1602.4 | 1996.02 | 2045.26 |
| one-process    | cold-many | asynchronous |   9.31 | 1712.83 | 2015.94 | 2103.85 |
| four-processes | warm-hot  | synchronous  |   72.5 |  200.22 |  328.44 |  390.64 |
| four-processes | warm-hot  | asynchronous |  91.59 |  170.03 |  235.96 |  254.63 |
| four-processes | warm-many | synchronous  | 105.16 |   58.47 |  363.58 | 1728.53 |
| four-processes | warm-many | asynchronous |  67.05 |  157.66 |  527.67 | 2119.43 |
| four-processes | cold-many | synchronous  |  31.69 |   445.1 |  935.43 | 1060.47 |
| four-processes | cold-many | asynchronous |  16.78 |  905.21 | 1264.06 | 1380.72 |

## mysql cart-outbox

Raw report: [mysql-cart-outbox.json](mysql-cart-outbox.json)

Database version: 26.10.0. Durability settings: {"innodbFlushLogAtTrxCommit":1,"syncBinlog":1}.

| Topology       | Shape     | Handler      | ops/s |  p50 ms |  p95 ms |  p99 ms |
| -------------- | --------- | ------------ | ----: | ------: | ------: | ------: |
| one-process    | warm-hot  | synchronous  |  31.2 |  520.94 |  700.73 |  801.39 |
| one-process    | warm-hot  | asynchronous | 33.49 |  471.86 |  626.42 |  644.86 |
| one-process    | warm-many | synchronous  | 36.36 |  259.12 |  797.72 |  4136.7 |
| one-process    | warm-many | asynchronous | 18.47 |  475.28 | 3163.54 | 8709.58 |
| one-process    | cold-many | synchronous  |  9.49 |  1657.4 | 2164.85 | 2316.84 |
| one-process    | cold-many | asynchronous |  9.24 | 1716.89 | 2079.01 | 2198.88 |
| four-processes | warm-hot  | synchronous  | 52.96 |  287.93 |  408.07 |  446.53 |
| four-processes | warm-hot  | asynchronous | 47.06 |  332.37 |  527.31 |  638.01 |
| four-processes | warm-many | synchronous  | 74.75 |  134.94 |  549.13 | 1926.81 |
| four-processes | warm-many | asynchronous | 45.65 |  191.92 |  846.39 | 3320.14 |
| four-processes | cold-many | synchronous  | 20.69 |  720.19 | 1118.29 | 1176.44 |
| four-processes | cold-many | asynchronous | 13.04 | 1165.77 | 1822.31 | 1937.33 |

## sqlite large state

Raw report: [sqlite-large-state.json](sqlite-large-state.json)

Database version: 3.53.1. Durability settings: "see methodology".

| Payload bytes | Persisted state bytes | ops/s | p50 ms | p95 ms | p99 ms |
| ------------: | --------------------: | ----: | -----: | -----: | -----: |
|             0 |                    26 |  93.6 |   9.29 |  21.09 |  26.88 |
|         16384 |                 16410 | 86.65 |   10.4 |  21.12 |  26.33 |
|        131072 |                131098 |  70.4 |  12.86 |  22.93 |  27.15 |
|       1048576 |               1048602 | 42.27 |  22.55 |  33.05 |  42.64 |

## sqlite idle

Raw report: [sqlite-idle.json](sqlite-idle.json)

Database version: 3.53.1. Durability settings: "see methodology".

| Fast interval ms | Idle ceiling ms | polls/s | CPU percent |
| ---------------: | --------------: | ------: | ----------: |
|               20 |            1000 |       4 |       0.122 |
|              100 |            1000 |   3.999 |       0.124 |
|              500 |            1000 |       4 |         0.1 |

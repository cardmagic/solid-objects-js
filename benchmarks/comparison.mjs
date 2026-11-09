import assert from "node:assert/strict"

export function validateComparison(comparison) {
  assert.ok(
    Number.isSafeInteger(comparison.rounds) &&
      comparison.rounds >= 3 &&
      comparison.rounds % 2 === 1,
    "use an odd number of rounds, at least three",
  )
  for (const key of ["operations", "warmup"])
    assert.ok(Number.isSafeInteger(comparison[key]) && comparison[key] > 0, `invalid ${key}`)
  for (const values of [
    comparison.databases,
    comparison.concurrencies,
    comparison.variants.map((variant) => variant.name),
  ]) {
    assert.ok(
      values.length > 0 && new Set(values).size === values.length,
      "empty or duplicate comparison inputs",
    )
  }
  assert.ok(
    comparison.databases.every((database) => ["sqlite", "postgresql", "mysql"].includes(database)),
    "unsupported database",
  )
  assert.ok(
    comparison.concurrencies.every((value) => Number.isSafeInteger(value) && value > 0),
    "invalid concurrency",
  )
  for (const variant of comparison.variants) {
    assert.match(variant.name, /^[a-z0-9][a-z0-9.-]*$/)
    assert.match(variant.version, /^\d+\.\d+\.\d+$/)
    if (variant.databases)
      assert.ok(
        variant.databases.length > 0 &&
          variant.databases.every((database) => comparison.databases.includes(database)),
        "invalid variant databases",
      )
    const usesSqlite =
      comparison.databases.includes("sqlite") &&
      (!variant.databases || variant.databases.includes("sqlite"))
    if (!usesSqlite) continue
    assert.ok(
      variant.sqliteDurability &&
        ["delete", "wal"].includes(variant.sqliteDurability.journalMode) &&
        [1, 2].includes(variant.sqliteDurability.synchronous),
      "missing or invalid SQLite durability",
    )
    if (!variant.synchronous) continue
    assert.ok(["normal", "full"].includes(variant.synchronous), "invalid SQLite synchronous option")
    assert.equal(
      variant.sqliteDurability.synchronous,
      variant.synchronous === "full" ? 2 : 1,
      "inconsistent SQLite durability",
    )
  }
  for (const database of comparison.databases)
    assert.ok(
      comparison.variants.filter(
        (variant) => !variant.databases || variant.databases.includes(database),
      ).length >= 2,
      "each database requires multiple variants",
    )
}

export function comparisonPlan(comparison, database, round) {
  const variants = comparison.variants.filter(
    (variant) => !variant.databases || variant.databases.includes(database),
  )
  assert.ok(variants.length > 1, "comparison requires multiple variants")
  const offset = (round - 1) % variants.length
  return [...variants.slice(offset), ...variants.slice(0, offset)]
}

export function validateComparisonReport(report, variant, comparison, concurrency, previous) {
  assert.equal(report.packageVersion, variant.version, "wrong loaded version")
  assert.equal(report.source.revision, variant.revision, "wrong source revision")
  assert.equal(report.source.runtimeSourceDirty, false, "modified runtime source")
  for (const key of ["runtimeSourceSha256", "runtimeArtifactSha256", "harnessSha256"]) {
    assert.match(report.source[key], /^[a-f0-9]{64}$/, `missing ${key}`)
    if (previous) assert.equal(report.source[key], previous.source[key], `changed ${key}`)
  }
  assert.equal(report.methodology.operations, comparison.operations)
  assert.equal(report.methodology.warmupOperations, comparison.warmup)
  assert.equal(report.methodology.concurrency, concurrency)
  assert.equal(report.methodology.repetitions, 1)
  assert.equal(report.methodology.workload, "counter")
  for (const [key, expected] of Object.entries({
    workerCount: 4,
    warmIdentityCount: 100,
    pollingIntervalMilliseconds: 5,
    idlePollingIntervalMilliseconds: 1000,
    latencyBoundary: "durable enqueue through committed result",
    percentile: "nearest rank",
  })) {
    assert.equal(report.methodology[key], expected, `changed methodology: ${key}`)
  }
  if (report.database.adapter === "sqlite")
    assert.deepEqual(report.database.durability, variant.sqliteDurability)
  const shapes = new Set()
  for (const row of report.results) {
    assert.equal(row.topology, "four-processes")
    assert.equal(row.handler, "synchronous")
    assert.equal(row.sample, 1)
    assert.equal(row.concurrency, concurrency)
    assert.equal(row.operations, comparison.operations)
    assert.equal(row.latenciesMilliseconds.length, comparison.operations)
    assert.ok(!shapes.has(row.shape), "duplicate scenario")
    shapes.add(row.shape)
    assert.ok(Number.isFinite(row.throughputPerSecond) && row.throughputPerSecond > 0)
    for (const value of row.latenciesMilliseconds) assert.ok(Number.isFinite(value) && value >= 0)
    for (const [key, percentile] of [
      ["p50", 50],
      ["p95", 95],
      ["p99", 99],
    ]) {
      const sorted = [...row.latenciesMilliseconds].sort((a, b) => a - b)
      const expected =
        Math.round(sorted[Math.ceil((sorted.length * percentile) / 100) - 1] * 100) / 100
      assert.equal(row.latencyMilliseconds[key], expected, `incorrect ${key}`)
    }
  }
  assert.deepEqual([...shapes].sort(), ["cold-many", "warm-hot", "warm-many"])
}

export function comparisonRows(samples, comparison) {
  validateComparison(comparison)
  const groups = new Map()
  const seen = new Set()
  const databases = new Map()
  let host, harness, dependencies, node
  const variants = new Map()
  for (const sample of samples) {
    const { report, variant: name, round, concurrency } = sample
    assert.ok(
      Number.isSafeInteger(round) && round >= 1 && round <= comparison.rounds,
      "invalid round",
    )
    assert.ok(comparison.concurrencies.includes(concurrency), "unexpected concurrency")
    const variant = comparison.variants.find((entry) => entry.name === name)
    assert.ok(variant, "unexpected variant")
    assert.ok(comparison.databases.includes(report.database.adapter), "unexpected database")
    assert.ok(
      !variant.databases || variant.databases.includes(report.database.adapter),
      "unexpected database",
    )
    validateComparisonReport(report, variant, comparison, concurrency, variants.get(name))
    const database = report.database.adapter
    const settings = {
      version: report.database.version,
      durability: database === "sqlite" ? undefined : report.database.durability,
    }
    if (databases.has(database))
      assert.deepEqual(settings, databases.get(database), "mixed database versions or durability")
    databases.set(database, settings)
    variants.set(name, report)
    const identity = `${report.database.adapter}|${name}|${concurrency}|${round}`
    assert.ok(!seen.has(identity), "duplicate sample")
    seen.add(identity)
    const currentHost = JSON.stringify([
      report.runtime.platform,
      report.runtime.cpu,
      report.runtime.logicalCpus,
      report.runtime.totalMemoryBytes,
    ])
    if (host) assert.equal(currentHost, host, "mixed hosts")
    if (harness) assert.equal(report.source.harnessSha256, harness, "mixed harnesses")
    if (dependencies) assert.deepEqual(report.dependencies, dependencies, "mixed drivers")
    if (node) assert.equal(report.runtime.node, node, "mixed Node versions")
    host = currentHost
    harness = report.source.harnessSha256
    dependencies = report.dependencies
    node = report.runtime.node
    for (const result of report.results) {
      const key = `${report.database.adapter}|${name}|${concurrency}|${result.shape}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(result)
    }
  }
  const expectedSamples = comparison.databases.reduce(
    (total, database) =>
      total +
      comparison.variants.filter(
        (variant) => !variant.databases || variant.databases.includes(database),
      ).length *
        comparison.concurrencies.length *
        comparison.rounds,
    0,
  )
  assert.equal(seen.size, expectedSamples, "missing samples")
  return [...groups].map(([key, rows]) => {
    assert.equal(rows.length, comparison.rounds, "missing repetitions")
    const throughput = rows.map((row) => row.throughputPerSecond).sort((a, b) => a - b)
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    return {
      key,
      samples: rows.length,
      ops: median(throughput),
      min: throughput[0],
      max: throughput.at(-1),
      p50: median(rows.map((row) => row.latencyMilliseconds.p50)),
      p99: median(rows.map((row) => row.latencyMilliseconds.p99)),
    }
  })
}

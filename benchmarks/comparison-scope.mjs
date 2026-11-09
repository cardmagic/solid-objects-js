import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  comparisonPlan,
  comparisonRows,
  validateComparison,
  validateComparisonReport,
} from "./comparison.mjs"

export function comparisonForDatabases(comparison, databases) {
  return {
    ...comparison,
    databases,
    variants: comparison.variants
      .filter(
        (variant) =>
          !variant.databases || variant.databases.some((database) => databases.includes(database)),
      )
      .map((variant) =>
        variant.databases
          ? {
              ...variant,
              databases: variant.databases.filter((database) => databases.includes(database)),
            }
          : variant,
      ),
  }
}

export async function completedComparison(directory, comparison) {
  validateComparison(comparison)
  const samples = []
  const completedDatabases = []
  let plannedReportCount = 0
  let emittedReportCount = 0
  for (const database of comparison.databases) {
    const reports = []
    let expected = 0
    for (let round = 1; round <= comparison.rounds; round++) {
      for (const concurrency of comparison.concurrencies) {
        for (const variant of comparisonPlan(comparison, database, round)) {
          expected++
          const file = `${database}-round-${round}-concurrency-${concurrency}-${variant.name}.json`
          let text
          try {
            text = await readFile(new URL(file, directory), "utf8")
          } catch (error) {
            if (error.code === "ENOENT") continue
            throw error
          }
          if (!text.trim()) continue
          const report = JSON.parse(text)
          assert.equal(report.database.adapter, database, "wrong database in archived report")
          validateComparisonReport(report, variant, comparison, concurrency)
          reports.push({ variant: variant.name, round, concurrency, file, report })
        }
      }
    }
    plannedReportCount += expected
    emittedReportCount += reports.length
    if (reports.length !== expected) continue
    completedDatabases.push(database)
    samples.push(...reports)
  }
  assert.ok(completedDatabases.length > 0, "no backend completed its sampling plan")
  return {
    comparison,
    completedDatabases,
    plannedReportCount,
    emittedReportCount,
    samples: samples.map(({ report, ...sample }) => sample),
    rows: comparisonRows(samples, comparisonForDatabases(comparison, completedDatabases)),
  }
}

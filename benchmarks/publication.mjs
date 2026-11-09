import assert from "node:assert/strict"

export function tableCells(markdown) {
  let section = ""
  const rows = []
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim().toLowerCase()
    if (!line.trim().startsWith("|")) continue
    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    rows.push(
      JSON.stringify([
        section,
        ...cells.map((cell) => {
          const number = cell.replaceAll(",", "")
          return /^\d+(\.\d+)?$/.test(number) ? String(Number(number)) : cell
        }),
      ]),
    )
  }
  return rows.sort()
}

export function assertPublishedTables(generated, published) {
  assert.deepEqual(
    tableCells(published),
    tableCells(generated),
    "published benchmark tables differ from raw reports",
  )
}

export function controlledTable(rows) {
  return [
    "| Database | Variant | Concurrency | Shape | Samples | Median ops/s | Min ops/s | Max ops/s | Median p50 ms | Median p99 ms |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (row) =>
        `| ${row.key.split("|").join(" | ")} | ${[row.samples, row.ops, row.min, row.max, row.p50, row.p99].join(" | ")} |`,
    ),
  ].join("\n")
}

export function baselineHeadline(reports) {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const rows = reports.flatMap((report) =>
    ["warm-hot", "warm-many", "cold-many"].map((shape) => {
      const samples = report.results.filter(
        (row) =>
          row.topology === "four-processes" && row.handler === "synchronous" && row.shape === shape,
      )
      const rates = samples.map((row) => row.throughputPerSecond)
      return `| ${report.database.adapter} | ${shape} | ${median(rates)} | ${Math.min(...rates)} | ${Math.max(...rates)} |`
    }),
  )
  return [
    "| Database | Shape | Median ops/s | Minimum ops/s | Maximum ops/s |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows,
  ].join("\n")
}

export function comparisonHeadline(result) {
  const columns = result.comparison.variants.map((variant) => variant.name)
  const rows = result.comparison.databases.flatMap((database) =>
    result.comparison.concurrencies.flatMap((concurrency) =>
      ["warm-hot", "warm-many", "cold-many"].map((shape) => {
        const values = columns.map(
          (variant) =>
            result.rows.find((row) => row.key === `${database}|${variant}|${concurrency}|${shape}`)
              ?.ops ?? "n/a",
        )
        return `| ${database} | ${concurrency} | ${shape} | ${values.join(" | ")} |`
      }),
    ),
  )
  return [
    `| Database | Concurrency | Shape | ${columns.map((name) => `${name} ops/s`).join(" | ")} |`,
    `| --- | ---: | --- | ${columns.map(() => "---:").join(" | ")} |`,
    ...rows,
  ].join("\n")
}

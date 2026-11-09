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

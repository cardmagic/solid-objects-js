export function postgresqlSql(sql: string): string {
  let parameter = 0
  let output = ""
  let mode: "single" | "double" | "lineComment" | "blockComment" | undefined
  let dollarQuote: string | undefined
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    const next = sql[index + 1]
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        output += dollarQuote
        index += dollarQuote.length - 1
        dollarQuote = undefined
      } else {
        output += character
      }
      continue
    }
    if (mode === "lineComment") {
      output += character
      if (character === "\n") mode = undefined
      continue
    }
    if (mode === "blockComment") {
      output += character
      if (character === "*" && next === "/") {
        output += next
        index += 1
        mode = undefined
      }
      continue
    }
    if (mode === "single") {
      output += character
      if (character === "'" && next === "'") {
        output += next
        index += 1
      } else if (character === "'") {
        mode = undefined
      }
      continue
    }
    if (mode === "double") {
      output += character
      if (character === '"' && next === '"') {
        output += next
        index += 1
      } else if (character === '"') {
        mode = undefined
      }
      continue
    }
    if (character === "-" && next === "-") {
      mode = "lineComment"
      output += character + next
      index += 1
      continue
    }
    if (character === "/" && next === "*") {
      mode = "blockComment"
      output += character + next
      index += 1
      continue
    }
    if (character === "$") {
      const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))
      if (match) {
        dollarQuote = match[0]
        output += dollarQuote
        index += dollarQuote.length - 1
        continue
      }
    }
    if (character === "'") {
      mode = "single"
      output += character
      continue
    }
    if (character === '"') {
      mode = "double"
      output += character
      continue
    }
    if (character === "?") {
      if (next === "?") {
        output += "?"
        index += 1
        continue
      }
      parameter += 1
      output += `$${parameter}`
      continue
    }
    output += character
  }
  return output
}

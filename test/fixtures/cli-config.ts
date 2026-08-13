import { sqlite } from "../../src/database/sqlite.js"
import { configure } from "../../src/runtime.js"

export default configure({
  database: sqlite({ path: ":memory:" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  authorizeDestroy: () => true,
  authorizeAdministration: ({ authorizationContext }) =>
    (authorizationContext as { source?: string } | undefined)?.source === "cli",
})

import { sqlite } from "../../src/database/sqlite.js"
import { configureSolidObjects } from "../../src/runtime.js"

export default configureSolidObjects({
  database: sqlite({ path: ":memory:" }),
  authorizeMessage: () => true,
  authorizeQuery: () => true,
  authorizeDestroy: () => true,
  authorizeAdministration: ({ authorizationContext }) =>
    (authorizationContext as { source?: string } | undefined)?.source === "cli",
})

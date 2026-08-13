import fs from "node:fs"
import path from "node:path"

fs.chmodSync(path.resolve("dist/executable.js"), 0o755)

import fs from "node:fs"
import path from "node:path"

fs.rmSync(path.resolve("dist"), { recursive: true, force: true })

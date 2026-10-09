import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

const source = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^solid-objects$/, replacement: source("index.ts") },
      { find: /^solid-objects\/core$/, replacement: source("core.ts") },
      { find: /^solid-objects\/database\/sqlite$/, replacement: source("database/sqlite.ts") },
    ],
  },
  test: { dir: "./test", exclude: [...configDefaults.exclude, "**/cloudflare/**"] },
})

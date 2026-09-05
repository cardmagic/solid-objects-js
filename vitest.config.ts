import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: { dir: "./test", exclude: [...configDefaults.exclude, "**/cloudflare/**"] },
})

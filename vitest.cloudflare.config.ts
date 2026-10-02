import { defineConfig } from "vitest/config"
import { cloudflareTest } from "@cloudflare/vitest-plugin"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/cloudflare/wrangler.jsonc" } })],
  test: {
    include: ["test/cloudflare/**/*.test.ts"],
    testTimeout: 15_000,
    expect: { poll: { timeout: 10_000 } },
  },
})

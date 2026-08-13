import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "node test/browser-server.mjs",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
})

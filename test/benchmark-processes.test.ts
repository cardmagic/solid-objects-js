import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { waitForWorkerReady } from "../benchmarks/processes.js"

describe("benchmark worker processes", () => {
  it("rejects when a worker exits before signaling readiness", async () => {
    const worker = fork(
      fileURLToPath(new URL("./fixtures/benchmark-worker-exit.mjs", import.meta.url)),
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    )

    await expect(waitForWorkerReady(worker)).rejects.toThrow(
      "benchmark worker exited before ready with code 7 and signal null",
    )
  })
})

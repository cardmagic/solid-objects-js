import { expect, test, type Page } from "@playwright/test"

interface WorkerReport {
  phases: string[]
  rollbackMessage: string
  clockSkewMilliseconds: number
}

function runWorkerPhase(page: Page, phase: string): Promise<WorkerReport> {
  return page.evaluate(
    (phaseName) =>
      new Promise<WorkerReport>((resolve, reject) => {
        const worker = new Worker("/sqlite-wasm-worker.mjs", { type: "module" })
        worker.onmessage = (event) => {
          worker.terminate()
          if (event.data.ok) {
            resolve(event.data.report as WorkerReport)
            return
          }
          reject(new Error(`${event.data.message}\n${event.data.stack}`))
        }
        worker.onerror = (event) => {
          worker.terminate()
          reject(new Error(event.message))
        }
        worker.postMessage({ phase: phaseName })
      }),
    phase,
  )
}

test("persists SQLite WASM state in OPFS across page reloads", async ({ page }) => {
  await page.goto("/")

  const first = await runWorkerPhase(page, "first")
  expect(first.phases).toEqual(["first"])
  expect(first.rollbackMessage).toBe("abort")
  expect(first.clockSkewMilliseconds).toBeLessThan(5_000)

  await page.reload()

  const second = await runWorkerPhase(page, "second")
  expect(second.phases).toEqual(["first", "second"])
})

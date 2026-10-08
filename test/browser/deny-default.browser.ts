import { expect, test } from "@playwright/test"

interface WorkerReport {
  ok: boolean
  name?: string
  message?: string
}

test("a browser worker with no authorization callbacks rejects actor calls", async ({ page }) => {
  await page.goto("/")

  const report = await page.evaluate(
    () =>
      new Promise<WorkerReport>((resolve, reject) => {
        const worker = new Worker("/deny-default-worker.mjs", { type: "module" })
        worker.onmessage = (event) => {
          worker.terminate()
          resolve(event.data as WorkerReport)
        }
        worker.onerror = (event) => {
          worker.terminate()
          reject(new Error(event.message))
        }
        worker.postMessage({})
      }),
  )

  expect(report).toMatchObject({ ok: false, name: "Unauthorized" })
})

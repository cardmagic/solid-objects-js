import { expect, test, type Page } from "@playwright/test"

interface RuntimeReport {
  count: number
  snapshot: { count: number }
}

function runRuntimePhase(page: Page, actorId: string): Promise<RuntimeReport> {
  return page.evaluate(
    (actorIdValue) =>
      new Promise<RuntimeReport>((resolve, reject) => {
        const worker = new Worker("/runtime-worker.mjs", { type: "module" })
        worker.onmessage = (event) => {
          worker.terminate()
          if (event.data.ok) {
            resolve(event.data.report as RuntimeReport)
            return
          }
          reject(new Error(`${event.data.message}\n${event.data.stack}`))
        }
        worker.onerror = (event) => {
          worker.terminate()
          reject(new Error(event.message))
        }
        worker.postMessage({ actorId: actorIdValue })
      }),
    actorId,
  )
}

test("runs the full runtime in a browser worker with durable actor state", async ({ page }) => {
  await page.goto("/")

  const first = await runRuntimePhase(page, "browser-counter")
  expect(first.count).toBe(1)
  expect(first.snapshot).toEqual({ count: 1 })

  await page.reload()

  const second = await runRuntimePhase(page, "browser-counter")
  expect(second.count).toBe(2)
  expect(second.snapshot).toEqual({ count: 2 })
})

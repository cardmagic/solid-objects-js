import { expect, test } from "@playwright/test"

test("live signals track a browser runtime actor", async ({ page }) => {
  await page.goto("/")

  const report = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker("/live-signals-worker.mjs", { type: "module" })
        worker.onmessage = (event) => {
          worker.terminate()
          if (event.data.ok) resolve(event.data.value)
          else reject(new Error(`${event.data.message}\n${event.data.stack}`))
        }
        worker.onerror = (event) => {
          worker.terminate()
          reject(new Error(event.message))
        }
        worker.postMessage({ requestId: crypto.randomUUID() })
      }),
  )

  expect(report).toMatchObject({ final: 2 })
  const observed = (report as { observed: number[] }).observed
  expect(observed[observed.length - 1]).toBe(2)
})

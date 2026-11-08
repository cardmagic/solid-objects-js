import { expect, test } from "@playwright/test"

interface ContextReport {
  synchronous: { details: { name: string } }
  promise: { details: { message: string } }
  timer: { details: { message: string } }
  rows: { boundary: string }[]
  transaction: {
    beforeAwait: boolean
    afterAwait: boolean
    waitError: { name: string }
  }
  transactionCallbackActive: boolean
  snapshot: { count: number }
}

test("browser guards lose async context while failed actor state still rolls back", async ({
  page,
}) => {
  await page.goto("/")
  const report = await page.evaluate(
    () =>
      new Promise<ContextReport>((resolve, reject) => {
        const worker = new Worker("/context-worker.mjs", { type: "module" })
        worker.onmessage = ({ data }) => {
          worker.terminate()
          if (data.ok) resolve(data.report)
          else reject(new Error(`${data.message}\n${data.stack}`))
        }
        worker.onerror = (event) => {
          worker.terminate()
          reject(new Error(event.message))
        }
        worker.postMessage({})
      }),
  )

  expect(report.synchronous.details.name).toBe("ApplicationWriteForbidden")
  expect(report.promise.details.message).toBe("roll back actor state")
  expect(report.timer.details.message).toBe("roll back actor state")
  expect(report.rows).toEqual([{ boundary: "promise" }, { boundary: "timer" }])
  expect(report.snapshot).toEqual({ count: 0 })
  // The adapter itself yields before entering an application's callback.
  expect(report.transactionCallbackActive).toBe(false)
  expect(report.transaction).toMatchObject({
    beforeAwait: true,
    afterAwait: false,
    waitError: { name: "SyncInsideTransaction" },
  })
})

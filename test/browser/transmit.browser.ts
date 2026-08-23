import { expect, test, type Page } from "@playwright/test"

function runWorkerCommand(
  page: Page,
  options: { command: string; actorId?: string; amounts?: number[] },
): Promise<unknown> {
  return page.evaluate(
    (input) =>
      new Promise((resolve, reject) => {
        const scope = window as unknown as { __syncWorker?: Worker }
        scope.__syncWorker ??= new Worker("/transmit-worker.mjs", { type: "module" })
        const worker = scope.__syncWorker
        const requestId = crypto.randomUUID()
        const onMessage = (event: MessageEvent) => {
          if (event.data.requestId !== requestId) return
          worker.removeEventListener("message", onMessage)
          if (event.data.ok) resolve(event.data.value)
          else reject(new Error(`${event.data.message}\n${event.data.stack}`))
        }
        worker.addEventListener("message", onMessage)
        worker.postMessage({ requestId, ...input })
      }),
    options,
  )
}

test("drains the browser outbox into the server runtime", async ({ page, request }) => {
  const actorId = `transmit-${Date.now()}`
  await page.goto("/")

  const localCount = await runWorkerCommand(page, { command: "run", actorId, amounts: [2, 3] })
  expect(localCount).toBe(5)

  await expect
    .poll(
      async () => {
        const response = await request.get(`/sync-state?actorId=${actorId}`)
        const body = (await response.json()) as { count?: number }
        return body.count ?? 0
      },
      { timeout: 15_000 },
    )
    .toBe(5)

  await runWorkerCommand(page, { command: "stop" })
})

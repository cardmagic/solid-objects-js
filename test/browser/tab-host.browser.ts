import { expect, test, type Page } from "@playwright/test"

async function startHostWorker(page: Page): Promise<void> {
  await page.goto("/")
  await page.evaluate(() => {
    const worker = new Worker("/tab-host-worker.mjs", { type: "module" })
    const waiters = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >()
    worker.onmessage = (event) => {
      const waiter = waiters.get(event.data.requestId)
      if (!waiter) return
      waiters.delete(event.data.requestId)
      if (event.data.ok) waiter.resolve(event.data.value)
      else waiter.reject(new Error(`${event.data.message}\n${event.data.stack}`))
    }
    const send = (command: string, actorId?: string) =>
      new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID()
        waiters.set(requestId, { resolve, reject })
        worker.postMessage({ requestId, command, actorId })
      })
    Object.assign(window, { __tabHostSend: send })
  })
}

function send(page: Page, options: { command: string; actorId?: string }): Promise<unknown> {
  return page.evaluate(
    ({ command, actorId }) =>
      (
        window as unknown as { __tabHostSend(command: string, actorId?: string): Promise<unknown> }
      ).__tabHostSend(command, actorId),
    options,
  )
}

test("shares one durable runtime across tabs and fails over", async ({ context }) => {
  const actorId = `shared-${Date.now()}`
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  await startHostWorker(pageA)
  await expect.poll(() => send(pageA, { command: "role" })).toBe("leader")
  await startHostWorker(pageB)

  expect(await send(pageA, { command: "increment", actorId })).toBe(1)
  expect(await send(pageB, { command: "increment", actorId })).toBe(2)
  expect(await send(pageB, { command: "role" })).toBe("follower")

  await pageA.close()

  expect(await send(pageB, { command: "increment", actorId })).toBe(3)
  await expect.poll(() => send(pageB, { command: "role" })).toBe("leader")
})

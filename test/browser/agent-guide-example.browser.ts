import { expect, test, type Page } from "@playwright/test"

interface DraftSnapshot {
  text: string
  revision: number
}

async function openPage(page: Page): Promise<void> {
  await page.goto("/")
}

type DraftCall =
  | { actorId: string; operation: "edit"; argumentsValue: { text: string } }
  | { actorId: string; operation: "snapshot"; argumentsValue?: never }

function callActor(page: Page, call: DraftCall): Promise<number | DraftSnapshot> {
  return page.evaluate(
    async ({ modulePath, callValue }) => {
      const { callActor: callFromPage } = await import(modulePath)
      return callFromPage(callValue)
    },
    { modulePath: "/examples/browser/page.js", callValue: call },
  )
}

test("runs the agent guide example with state that survives a reload", async ({ page }) => {
  const actorId = `guide-note-${Date.now()}`
  await openPage(page)

  const revisions = await Promise.all([
    callActor(page, { actorId, operation: "edit", argumentsValue: { text: "first" } }),
    callActor(page, { actorId, operation: "edit", argumentsValue: { text: "second" } }),
  ])
  expect([...revisions].sort()).toEqual([1, 2])

  await page.reload()

  const snapshot = (await callActor(page, { actorId, operation: "snapshot" })) as DraftSnapshot
  expect(snapshot.revision).toBe(2)
  expect(["first", "second"]).toContain(snapshot.text)
})

test("shares one draft between tabs and continues after the holder tab closes", async ({
  context,
}) => {
  const actorId = `guide-tabs-${Date.now()}`
  const firstTab = await context.newPage()
  const secondTab = await context.newPage()
  await openPage(firstTab)
  await openPage(secondTab)

  await callActor(firstTab, { actorId, operation: "snapshot" })

  const revisions = await Promise.all([
    callActor(firstTab, { actorId, operation: "edit", argumentsValue: { text: "one" } }),
    callActor(secondTab, { actorId, operation: "edit", argumentsValue: { text: "two" } }),
  ])
  expect([...revisions].sort()).toEqual([1, 2])

  await firstTab.close()

  expect(
    await callActor(secondTab, { actorId, operation: "edit", argumentsValue: { text: "three" } }),
  ).toBe(3)
  expect(await callActor(secondTab, { actorId, operation: "snapshot" })).toEqual({
    text: "three",
    revision: 3,
  })
})

test("rejects calls when the worker cannot load", async ({ page }) => {
  test.setTimeout(10_000)
  await page.route("**/examples/browser/draft-worker.js", (route) => route.fulfill({ status: 404 }))
  await openPage(page)

  await expect(callActor(page, { actorId: "missing", operation: "snapshot" })).rejects.toThrow(
    /worker/,
  )
  await expect(callActor(page, { actorId: "missing", operation: "snapshot" })).rejects.toThrow(
    /worker/,
  )
})

import { expect, test, type Page } from "@playwright/test"

interface DraftSnapshot {
  text: string
  revision: number
}

async function openPage(page: Page): Promise<void> {
  await page.goto("/")
}

function callActor(
  page: Page,
  call: { actorId: string; operation: string; argumentsValue?: unknown },
): Promise<unknown> {
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

  expect(
    await callActor(firstTab, { actorId, operation: "edit", argumentsValue: { text: "one" } }),
  ).toBe(1)
  expect(
    await callActor(secondTab, { actorId, operation: "edit", argumentsValue: { text: "two" } }),
  ).toBe(2)

  await firstTab.close()

  expect(
    await callActor(secondTab, { actorId, operation: "edit", argumentsValue: { text: "three" } }),
  ).toBe(3)
  expect(await callActor(secondTab, { actorId, operation: "snapshot" })).toEqual({
    text: "three",
    revision: 3,
  })
})

import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

type InspectionCall =
  | { actorId: string; operation: "record"; argumentsValue: { findingId: string; note: string } }
  | { actorId: string; operation: "snapshot"; argumentsValue?: never }

function callInspection(page: Page, call: InspectionCall): Promise<unknown> {
  return page.evaluate(
    async ({ modulePath, callValue }) => {
      const { callActor } = await import(modulePath)
      return callActor(callValue)
    },
    { modulePath: "/examples/guides/offline-first/page.js", callValue: call },
  )
}

async function serverFindingIds(request: APIRequestContext, actorId: string): Promise<string[]> {
  const response = await request.get(`/inspections/state?actorId=${actorId}`)
  const body = (await response.json()) as { findings: { findingId: string }[] }
  return body.findings.map((finding) => finding.findingId)
}

test("records findings offline in two tabs and syncs them once, in order", async ({
  context,
  request,
  baseURL,
}) => {
  test.setTimeout(60_000)
  const actorId = `site-${Date.now()}`
  await context.addCookies([{ name: "device", value: "tablet-7", url: baseURL ?? "" }])
  await request.post("/inspections/network?online=false")
  const firstTab = await context.newPage()
  const secondTab = await context.newPage()
  await firstTab.goto("/")
  await secondTab.goto("/")

  await callInspection(firstTab, {
    actorId,
    operation: "record",
    argumentsValue: { findingId: "finding-1", note: "Crack in the north wall" },
  })
  await callInspection(firstTab, {
    actorId,
    operation: "record",
    argumentsValue: { findingId: "finding-2", note: "Loose handrail" },
  })
  await callInspection(secondTab, {
    actorId,
    operation: "record",
    argumentsValue: { findingId: "finding-3", note: "Exit sign is dark" },
  })
  await firstTab.waitForTimeout(1_500)
  expect(await serverFindingIds(request, actorId)).toEqual([])

  await request.post("/inspections/network?online=true")

  await expect
    .poll(() => serverFindingIds(request, actorId), { timeout: 30_000 })
    .toEqual(["finding-1", "finding-2", "finding-3"])
  await firstTab.waitForTimeout(1_500)
  expect(await serverFindingIds(request, actorId)).toEqual(["finding-1", "finding-2", "finding-3"])
})

test("keeps the local findings after a reload", async ({ page }) => {
  const actorId = `site-reload-${Date.now()}`
  await page.goto("/")
  await callInspection(page, {
    actorId,
    operation: "record",
    argumentsValue: { findingId: "finding-1", note: "Crack in the north wall" },
  })

  await page.reload()

  const snapshot = (await callInspection(page, { actorId, operation: "snapshot" })) as {
    findings: { findingId: string }[]
  }
  expect(snapshot.findings.map((finding) => finding.findingId)).toEqual(["finding-1"])
})

test("loses edits that wait in page memory when the page reloads", async ({ page }) => {
  const modulePath = "/examples/guides/offline-first/memory-outbox.js"
  await page.goto("/")
  const before = await page.evaluate(async (path) => {
    const outbox = await import(path)
    outbox.queueFinding({ findingId: "finding-1", note: "Crack in the north wall" })
    outbox.queueFinding({ findingId: "finding-2", note: "Loose handrail" })
    return outbox.pendingFindings()
  }, modulePath)
  expect(before).toBe(2)

  await page.reload()

  const after = await page.evaluate(
    async (path) => (await import(path)).pendingFindings(),
    modulePath,
  )
  expect(after).toBe(0)
})

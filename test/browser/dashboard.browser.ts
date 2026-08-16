import { expect, test } from "@playwright/test"

test("renders and live-refreshes the operator dashboard", async ({ page }) => {
  await page.goto("/dashboard")

  await expect(page.getByText("Operator dashboard", { exact: true })).toBeVisible()
  await expect(page.locator('canvas[data-chart="instances_by_type"]')).toHaveAttribute(
    "data-chart-values",
    /DashboardBrowserActor/,
  )
  await expect(page.locator("canvas[data-chart]")).toHaveCount(3)
  await expect(page.locator("canvas[data-rendered=true]")).toHaveCount(3)

  const frame = page.locator(".chart-frame").first()
  const canvas = frame.locator("canvas")
  expect(await frame.evaluate((element) => getComputedStyle(element).height)).toBe("260px")
  expect(await canvas.evaluate((element) => getComputedStyle(element).position)).toBe("absolute")

  await page.getByRole("button", { name: "Live" }).click()
  await expect(page.locator('[data-statistic="mailbox.ready"]')).toHaveText("1,234")
  await expect(page.locator('[data-statistic="mailbox.latency"]')).toHaveText("1 min 1 s")
  await expect(page.locator("canvas[data-updated=true]")).toHaveCount(2)
})

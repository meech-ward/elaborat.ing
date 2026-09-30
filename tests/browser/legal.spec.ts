import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The support, privacy and terms pages, linked from the foot of the home and sign-in pages.

async function fitsAndAxeFindsNothing(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
}

for (const [scheme, width] of [["light", 1280], ["dark", 390]] as const) {
  test(`in ${scheme} at ${width}px, the home and sign-up pages link to Support, Privacy and Terms, which fit and axe finds nothing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.emulateMedia({ colorScheme: scheme })
    await fakeSupabase(page)
    const legal = page.getByRole("navigation", { name: "Support, privacy and terms" })

    await page.goto(APP_URL)
    await legal.getByRole("link", { name: "Privacy" }).click()
    await expect(page).toHaveURL(new URL("privacy", APP_URL).href)
    await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible()
    await expect(page.getByText("Last updated September 30, 2026")).toBeVisible()
    await fitsAndAxeFindsNothing(page)

    await legal.getByRole("link", { name: "Support" }).click()
    await expect(page).toHaveURL(new URL("support", APP_URL).href)
    await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible()
    await expect(page.getByRole("link", { name: "GitHub repository" })).toHaveAttribute("href", "https://github.com/meech-ward/elaborat.ing/issues")
    await fitsAndAxeFindsNothing(page)
    await page.getByRole("button", { name: "Open Settings" }).click()
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
    await page.keyboard.press("Escape")

    await page.goto(new URL("sign-up", APP_URL).href)
    await legal.getByRole("link", { name: "Terms" }).click()
    await expect(page).toHaveURL(new URL("terms", APP_URL).href)
    await expect(page.getByRole("heading", { level: 1, name: "Terms" })).toBeVisible()
    await fitsAndAxeFindsNothing(page)
    await page.getByRole("link", { name: "Home", exact: true }).click()
    await expect(page).toHaveURL(APP_URL)
  })
}

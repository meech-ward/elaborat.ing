import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { palettes } from "../../src/features/appearance/palettes.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The style guide page: the foundations in the active palette, the palette
// and mode switch, and the component sections in their places.

const styleGuideUrl = new URL("style-guide", APP_URL).href
const supabase = palettes.find((palette) => palette.id === "supabase-green")!
const glacier = palettes.find((palette) => palette.id === "glacier-cyan")!

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`

/** Every swatch as [token, the hex it shows, the colour its chip paints]. */
const swatches = (page: Page) =>
  page.locator("[data-token]").evaluateAll((items) =>
    items.map((item) => [
      item.getAttribute("data-token"),
      item.lastElementChild?.textContent,
      getComputedStyle(item.firstElementChild!).backgroundColor,
    ]),
  )

async function expectSwatchesMatch(page: Page, colors: Record<string, string>) {
  const found = await swatches(page)
  expect(found).toHaveLength(39)
  for (const [token, shown, painted] of found) {
    expect(shown, `${token} shows the palette value`).toBe(colors[token!])
    expect(painted, `${token} paints its value`).toBe(rgb(shown!))
  }
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
}

test.beforeEach(async ({ page }) => {
  await fakeSupabase(page)
})

test("the foundations show the active palette, and the component sections sit in order", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto(styleGuideUrl)
  await expect(page.getByRole("heading", { level: 1, name: "elaborat.ing style guide" })).toBeVisible()
  await expect(page.getByText("Supabase Green, light, following the device.", { exact: false })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex")

  const cards = page.getByRole("region")
  const colours = cards.filter({ has: page.getByRole("heading", { level: 2, name: "Colour tokens" }) })
  for (const group of ["Surfaces", "Text", "Accent", "Status", "Files and code", "Canvas"]) {
    await expect(colours.getByRole("heading", { level: 3, name: group, exact: true })).toBeVisible()
  }
  await expectSwatchesMatch(page, supabase.light as unknown as Record<string, string>)
  for (const name of ["Type", "Space, radius, elevation, icons"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible()
  }
  await expect(page.getByText("Customer model")).toBeVisible()

  const components = cards.filter({ has: page.getByRole("heading", { level: 2, name: "Components and states" }) })
  const c5 = cards.filter({ has: page.getByRole("heading", { level: 2, name: "C5 components" }) })
  await expect(components.getByRole("heading", { level: 3 })).toHaveText(["Controls", "Navigation"])
  await expect(c5.getByRole("heading", { level: 3 })).toHaveText(["Editor chrome", "Canvas"])
})

test("the palette and mode switch repaint the page and stay chosen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto(styleGuideUrl)
  await page.getByRole("combobox", { name: "Palette" }).click()
  await page.getByRole("option", { name: "Glacier Cyan" }).click()
  const mode = page.getByRole("group", { name: "Mode" })
  await mode.getByRole("button", { name: "Dark" }).click()
  await expect(mode.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByText("Glacier Cyan, dark.", { exact: false })).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "glacier-cyan")
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark")
  await expectSwatchesMatch(page, glacier.dark as unknown as Record<string, string>)

  await page.reload()
  await expect(page.getByRole("combobox", { name: "Palette" })).toContainText("Glacier Cyan")
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark")
})

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(styleGuideUrl)
    await expect(page.locator("[data-token]").first()).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-scheme", scheme)
    await expectAxeClean(page)
  })
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the page fits", async ({ page }) => {
    await page.goto(styleGuideUrl)
    await expect(page.locator("[data-token]").first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
})

import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { palettes } from "../../src/features/appearance/palettes.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Settings > Appearance: the colour palette and light, dark or the device's
// setting, kept on this device.

test.describe.configure({ timeout: 60_000 })

const glacier = palettes.find((palette) => palette.id === "glacier-cyan")!
const supabase = palettes.find((palette) => palette.id === "supabase-green")!
// The document area takes the palette's panel colour (tokens.ts).
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())

async function openProject(page: Page) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  await fake.server.remote(person.id).createProject(id, "Notes")
  await signedIn(page)
  await page.goto(new URL(`projects/${id}`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
}

test("a palette and dark mode chosen in Settings apply at once and survive a reload", async ({ page }) => {
  await openProject(page)
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("radio", { name: "Glacier Cyan" }).check()
  await dialog.getByRole("radio", { name: "Dark" }).check()
  await expect.poll(() => background(page)).toBe(glacier.dark.panel)
  expect(await new AxeBuilder({ page }).include('[role="dialog"]').analyze().then((result) => result.violations)).toEqual([])

  await page.reload()
  await expect.poll(() => background(page)).toBe(glacier.dark.panel)
})

test("System follows the device while the page is open", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await openProject(page)
  await page.getByRole("button", { name: "Workbench menu" }).click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  await page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name: "System" }).check()
  await expect.poll(() => background(page)).toBe(supabase.light.panel)
  await page.emulateMedia({ colorScheme: "dark" })
  await expect.poll(() => background(page)).toBe(supabase.dark.panel)
})

test("a first visit is Supabase Green, following the device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await openProject(page)
  await expect.poll(() => background(page)).toBe(supabase.light.panel)
  await expect(page.locator("html")).not.toHaveClass(/dark/)
})

test("Settings opens from the home page", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name: "Supabase Green" })).toBeChecked()
})

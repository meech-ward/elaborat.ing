import AxeBuilder from "./axe.ts"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Every dialog is the same shell: keyboard focus stays inside it, Escape
// closes it and returns focus to what opened it, and axe finds nothing in it,
// on a desktop and on a phone.

test.describe.configure({ timeout: 60_000 })

async function openProject(page: Page, files: Record<string, string>, phone: boolean) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/index.md`, APP_URL).href)
  if (phone) {
    await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Back to files and projects" }).click()
  } else {
    await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
    // A desktop opens with the explorer shown.
    await expect(page.getByRole("navigation", { name: "Workspace files" }).first()).toBeVisible()
  }
  const explorer = page.getByRole("navigation", { name: "Workspace files" }).first()
  await explorer.getByRole("button", { name: "notes", exact: true, expanded: false }).click()
  return explorer
}

async function expectNoAxeViolations(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
}

const holdsFocus = (dialog: Locator) => dialog.evaluate((element) => element.contains(document.activeElement))

for (const { width, phone } of [
  { width: 1280, phone: false },
  { width: 390, phone: true },
]) {
  test.describe(`${width} wide`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: phone })

    test("Tab stays in the rename dialog, Escape returns to its opener, and axe finds nothing in rename or delete", async ({ page }) => {
      const explorer = await openProject(page, { "index.md": "See [the plan](notes/plan.md).\n", "notes/plan.md": "# Plan\n" }, phone)
      const opener = explorer.getByRole("button", { name: "Actions for notes/plan.md", exact: true })
      await opener.click()
      await page.getByRole("menuitem", { name: "Rename" }).click()
      const dialog = page.getByRole("dialog", { name: "Rename in notes" })
      await expect(dialog.getByLabel("New file name")).toBeFocused()
      await expectNoAxeViolations(page, ".wb-rename")

      // The field, Cancel and Rename: Tab and Shift+Tab go round them and never leave.
      for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
        await page.keyboard.press(key)
        await expect.poll(() => holdsFocus(dialog)).toBe(true)
      }
      await page.keyboard.press("Escape")
      await expect(dialog).toBeHidden()
      await expect(opener).toBeFocused()

      await opener.click()
      await page.getByRole("menuitem", { name: "Delete" }).click()
      const confirm = page.getByRole("alertdialog", { name: "Delete notes/plan.md" })
      await expect(confirm.getByRole("region", { name: "What goes" }).getByText("Line 1: notes/plan.md", { exact: true })).toBeVisible()
      await expectNoAxeViolations(page, ".wb-move")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    })
  })
}

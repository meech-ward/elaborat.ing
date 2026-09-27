import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// On a desktop a note can show its source and its rendered view side by side.
// Both panes show every edit made in either one, undo works in each, and one
// save writes the file once with all of them. Split is desktop only.

test.describe.configure({ timeout: 60_000 })
test.use({ viewport: { width: 1280, height: 800 } })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/split.md"
const NOTE = "# Split\n\nFirst paragraph here.\n\nSecond paragraph here.\n"

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const paragraph = (page: Page, text: string) => page.frameLocator(FRAME).locator("p").filter({ hasText: text })
const sourceText = (page: Page) => page.locator(".monaco-editor:visible .view-lines")
const saves = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length
const view = (page: Page, name: string) => page.getByRole("button", { name, exact: true })

async function openNote(page: Page) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

async function toSplit(page: Page) {
  await view(page, "Split").click()
  await expect(view(page, "Split")).toHaveAttribute("aria-pressed", "true")
  await expect(paragraph(page, "First paragraph")).toBeVisible()
  await expect(sourceText(page)).toBeVisible()
}

test("in Split, typing in Source shows in Rendered and the reverse, and one save writes both", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await toSplit(page)

  await sourceText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Typed in source.")
  await expect(paragraph(page, "Typed in source.")).toBeVisible()

  await paragraph(page, "First paragraph").click()
  await page.keyboard.press("End")
  await page.keyboard.type(" Typed in rendered.")
  await expect(sourceText(page)).toContainText("First paragraph here. Typed in rendered.")
  await expect(paragraph(page, "Typed in source.")).toBeVisible()

  const before = saves(fake)
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Save" }).click()
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  await quiet(fake, 1_500)
  expect(saves(fake) - before).toBe(1)
  expect(fake.server.content(id, PATH)).toBe(
    "# Split\n\nFirst paragraph here. Typed in rendered.\n\nSecond paragraph here.\n\nTyped in source.",
  )
})

test("in Split, undo works in each pane and both panes follow it", async ({ page }) => {
  await openNote(page)
  await toSplit(page)

  await paragraph(page, "First paragraph").click()
  await page.keyboard.press("End")
  await page.keyboard.type(" ONE")
  await expect(sourceText(page)).toContainText("First paragraph here. ONE")
  await page.keyboard.press("ControlOrMeta+z")
  await expect(sourceText(page)).not.toContainText("ONE")
  await expect(paragraph(page, "First paragraph")).toHaveText("First paragraph here.")

  await sourceText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("TWO")
  await expect(paragraph(page, "Second paragraph")).toContainText("TWO")
  await page.keyboard.press("ControlOrMeta+z")
  await expect(paragraph(page, "Second paragraph")).toHaveText("Second paragraph here.")
})

test("the view shortcuts switch views, and the buttons show them", async ({ page }) => {
  await openNote(page)
  await expect(view(page, "Split")).toHaveAttribute("aria-keyshortcuts", "Control+Alt+2")
  await expect(view(page, "Split")).toHaveAttribute("title", "Split (Ctrl+Alt+2)")
  await expect(view(page, "Source")).toHaveAttribute("aria-keyshortcuts", "Control+Alt+1")
  await expect(view(page, "Rendered")).toHaveAttribute("aria-keyshortcuts", "Control+Alt+3")

  await page.keyboard.press("Control+Alt+Digit2")
  await expect(view(page, "Split")).toHaveAttribute("aria-pressed", "true")
  await expect(paragraph(page, "First paragraph")).toBeVisible()
  // The keys still switch while the source editor has the keyboard.
  await sourceText(page).click()
  await page.keyboard.press("Control+Alt+Digit3")
  await expect(view(page, "Rendered")).toHaveAttribute("aria-pressed", "true")
  await expect(sourceText(page)).toHaveCount(0)
  await page.keyboard.press("Control+Alt+Digit1")
  await expect(view(page, "Source")).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(FRAME)).toBeHidden()
})

test("a note left in Split opens in Rendered on a phone", async ({ page }) => {
  await openNote(page)
  await toSplit(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(paragraph(page, "First paragraph")).toBeVisible({ timeout: 15_000 })
  await expect(view(page, "Rendered")).toHaveAttribute("aria-pressed", "true")
  await expect(view(page, "Split")).toHaveCount(0)
  await expect(sourceText(page)).toHaveCount(0)
})

test("Split has no accessibility problems at 1280", async ({ page }) => {
  await openNote(page)
  await toSplit(page)
  // The side panels' resize handle sits outside every landmark (see projects.spec.ts).
  const results = await new AxeBuilder({ page }).exclude('[data-slot="resizable-handle"]').analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
})

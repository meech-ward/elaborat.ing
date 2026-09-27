import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Switching a note to Source and back to Rendered, without editing, leaves the
// rendered view as it was: the reading position stays, nothing takes focus,
// and the note is not changed or saved. Clicking the prose still edits it.

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/long.md"
const line = (n: number) => `Paragraph ${n} of a long note, with enough words in it to wrap on a phone.`
const NOTE = `# A long note\n\n${Array.from({ length: 60 }, (_, index) => line(index + 1)).join("\n\n")}\n`

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const frameOf = (page: Page) => page.frameLocator(FRAME)
// The open file's panel, in the desktop and phone layouts alike.
const panel = (page: Page) => page.getByRole("tabpanel", { name: PATH })
// On a desktop the saved state of the open file is in the editor's top line.
const unsaved = (page: Page) => page.getByRole("main").getByText("Unsaved changes", { exact: true })
const saves = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length

async function openNote(page: Page) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await expect(panel(page)).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect(frameOf(page).locator("p").filter({ hasText: line(60) })).toBeAttached()
  return { fake, id }
}

/** How far the rendered note is scrolled. */
const scrollTop = (page: Page) => frameOf(page).locator(":root").evaluate(() => document.scrollingElement!.scrollTop)

/** Whether editable prose in the frame has focus. */
const proseFocused = (page: Page) =>
  frameOf(page).locator(":root").evaluate(() => document.hasFocus() && document.activeElement?.closest('[contenteditable="true"]') != null)

async function save(page: Page) {
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Save" }).click()
}

function journeys() {
  test("going to Source and back to Rendered keeps the reading position, takes no focus and changes nothing", async ({ page }) => {
    const { fake, id } = await openNote(page)
    // Scroll well below the fold, as a person would.
    await page.locator(FRAME).hover()
    await page.mouse.wheel(0, 1500)
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(300)
    await page.waitForTimeout(300)
    const before = await scrollTop(page)
    const saved = saves(fake)

    await page.getByRole("button", { name: "Source" }).click()
    await expect(page.locator(".monaco-editor:visible")).toBeVisible()
    await page.getByRole("button", { name: "Rendered" }).click()
    await expect(page.locator(FRAME)).toBeVisible()
    await expect.poll(async () => Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2)
    // It stays there, and nothing in the frame takes focus.
    await page.waitForTimeout(500)
    expect(Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2)
    expect(await proseFocused(page)).toBe(false)

    await expect(unsaved(page)).toHaveCount(0)
    await quiet(fake)
    expect(saves(fake)).toBe(saved)
    expect(fake.server.content(id, PATH)).toBe(NOTE)
  })

  test("clicking a deep paragraph edits it, and Ctrl+Z in the frame restores the exact source", async ({ page }) => {
    const { fake, id } = await openNote(page)
    // The heading comes first, so paragraph 45 is the 45th paragraph element.
    const deep = frameOf(page).locator("p").nth(44)
    await expect(deep).toHaveText(line(45))
    await deep.scrollIntoViewIfNeeded()
    await deep.click()
    expect(await proseFocused(page)).toBe(true)
    await page.keyboard.type("XYZ")
    await expect(deep).toContainText("XYZ")
    await expect(unsaved(page)).toBeVisible()

    await page.keyboard.press("ControlOrMeta+z")
    await expect(deep).toHaveText(line(45))
    // Saving now writes the exact original bytes, so the server's copy is unchanged.
    // The app syncs a second after a save, so wait out that second before reading it.
    await save(page)
    await expect(unsaved(page)).toHaveCount(0)
    await quiet(fake, 1_500)
    expect(fake.server.content(id, PATH)).toBe(NOTE)
  })
}

journeys()

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  journeys()
})

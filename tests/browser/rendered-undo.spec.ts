import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// A rendered edit changes the note's source, and the Source editor records it
// in its own undo history, so both views share one history: Ctrl+Z in Source
// undoes a rendered edit, and Ctrl+Z in the rendered prose asks that same
// history, one edit at a time.

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/undo.md"
const FIRST = "The first paragraph takes one edit."
const SECOND = "The second paragraph takes another."
const NOTE = `# Undo across views\n\n${FIRST}\n\n${SECOND}\n\nThe last paragraph is never edited.\n`

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const frameOf = (page: Page) => page.frameLocator(FRAME)
const first = (page: Page) => frameOf(page).locator("p").filter({ hasText: "The first paragraph" })
const second = (page: Page) => frameOf(page).locator("p").filter({ hasText: "The second paragraph" })
const sourceText = (page: Page) => page.locator(".monaco-editor:visible .view-lines")

async function openNote(page: Page) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect(first(page)).toHaveText(FIRST, { timeout: 15_000 })
  return { fake, id }
}

/** Click a rendered paragraph and type at its end. */
async function typeAtEnd(page: Page, paragraph: ReturnType<typeof first>, text: string) {
  await paragraph.click()
  await page.keyboard.press("End")
  await page.keyboard.type(text)
}

/** Show Source and put the keyboard in it. */
async function toSource(page: Page) {
  await page.getByRole("button", { name: "Source" }).click()
  await expect(sourceText(page)).toBeVisible()
  await sourceText(page).click()
}

async function toRendered(page: Page) {
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect(page.locator(FRAME)).toBeVisible()
}

/**
 * Save, and return the server's copy once the save has synced. The app syncs
 * a second after a save, and sends nothing when the text equals the server's
 * copy, so wait for a quiet spell longer than that second, not for a request.
 */
async function saved(page: Page, fake: FakeSupabase, id: string) {
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Save" }).or(page.getByRole("button", { name: "Save" })).first().click()
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  await quiet(fake, 1_500)
  return fake.server.content(id, PATH)
}

test("Ctrl+Z in Source undoes a rendered edit exactly, and Ctrl+Shift+Z brings it back in both views", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await typeAtEnd(page, first(page), " EDITED")
  await expect(first(page)).toHaveText(`${FIRST} EDITED`)

  await toSource(page)
  await expect(sourceText(page)).toContainText(`${FIRST} EDITED`)
  await page.keyboard.press("ControlOrMeta+z")
  await expect(sourceText(page)).not.toContainText("EDITED")
  await expect(sourceText(page)).toContainText(FIRST)
  // The exact original bytes: saving now stores the note as it was.
  expect(await saved(page, fake, id)).toBe(NOTE)
  await toRendered(page)
  await expect(first(page)).toHaveText(FIRST)

  await toSource(page)
  await page.keyboard.press("ControlOrMeta+Shift+z")
  await expect(sourceText(page)).toContainText(`${FIRST} EDITED`)
  await toRendered(page)
  await expect(first(page)).toHaveText(`${FIRST} EDITED`)
  expect(await saved(page, fake, id)).toBe(NOTE.replace(FIRST, `${FIRST} EDITED`))
})

test("two rendered edits in a row undo one at a time in Source, newest first", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await typeAtEnd(page, first(page), " ONE")
  await typeAtEnd(page, second(page), " TWO")
  await expect(second(page)).toHaveText(`${SECOND} TWO`)

  await toSource(page)
  await page.keyboard.press("ControlOrMeta+z")
  await expect(sourceText(page)).not.toContainText("TWO")
  await expect(sourceText(page)).toContainText(`${FIRST} ONE`)
  await page.keyboard.press("ControlOrMeta+z")
  await expect(sourceText(page)).not.toContainText("ONE")
  expect(await saved(page, fake, id)).toBe(NOTE)
})

test("Ctrl+Z in the rendered prose undoes the same way, newest first, and Ctrl+Shift+Z redoes", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await typeAtEnd(page, first(page), " ONE")
  await typeAtEnd(page, second(page), " TWO")
  await expect(second(page)).toHaveText(`${SECOND} TWO`)

  await page.keyboard.press("ControlOrMeta+z")
  await expect(second(page)).toHaveText(SECOND)
  await expect(first(page)).toHaveText(`${FIRST} ONE`)
  await page.keyboard.press("ControlOrMeta+z")
  await expect(first(page)).toHaveText(FIRST)
  // The exact original bytes, as Ctrl+Z in Source gives.
  expect(await saved(page, fake, id)).toBe(NOTE)

  // Back in the prose, redo brings the edits back, oldest first.
  await first(page).click()
  await page.keyboard.press("ControlOrMeta+Shift+z")
  await expect(first(page)).toHaveText(`${FIRST} ONE`)
  await expect(second(page)).toHaveText(SECOND)
  await page.keyboard.press("ControlOrMeta+Shift+z")
  await expect(second(page)).toHaveText(`${SECOND} TWO`)

  // Source holds the same history: one Ctrl+Z there undoes TWO again.
  await toSource(page)
  await expect(sourceText(page)).toContainText(`${SECOND} TWO`)
  await page.keyboard.press("ControlOrMeta+z")
  await expect(sourceText(page)).not.toContainText("TWO")
  await expect(sourceText(page)).toContainText(`${FIRST} ONE`)
  expect(await saved(page, fake, id)).toBe(NOTE.replace(FIRST, `${FIRST} ONE`))
})

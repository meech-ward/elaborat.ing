import { expect, test, type Locator, type Page } from "./fixtures.ts"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

// Switching a note between Rendered and Source keeps the person's place: the
// caret or the selection in one view is where the other opens, in view and
// with the keyboard, and with neither, the text at the top of one is what the
// other shows. On a phone the views are switched from the "..." menu.

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/long.md"
const line = (n: number) => `Paragraph ${n} of a long note, with enough words in it to wrap on a phone.`
const NOTE = `# A long note\n\n${Array.from({ length: 60 }, (_, index) => line(index + 1)).join("\n\n")}\n`

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const frameOf = (page: Page) => page.frameLocator(FRAME)
// The heading comes first, so paragraph n is the nth paragraph element.
const paragraph = (page: Page, n: number) => frameOf(page).locator("p").nth(n - 1)
const sourceEditor = (page: Page) => page.locator(".monaco-editor:visible")
// A line of the source editor starting paragraph n (the editor draws spaces as no-break spaces).
const sourceLine = (page: Page, n: number) => sourceEditor(page).locator(".view-line").filter({ hasText: new RegExp(`^Paragraph\\s${n}\\s`) })

async function openNote(page: Page): Promise<{ fake: FakeSupabase; id: string }> {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Rendered")
  await expect(paragraph(page, 60)).toHaveText(line(60))
  return { fake, id }
}

/** Whether a line of the source editor shows `text` wholly inside the editor. */
const sourceShows = (page: Page, text: string) =>
  sourceEditor(page).evaluate((editor, text) => {
    const box = editor.getBoundingClientRect()
    return [...editor.querySelectorAll(".view-line")].some((row) => {
      const at = row.getBoundingClientRect()
      return (row.textContent ?? "").replaceAll(" ", " ").includes(text) && at.top >= box.top && at.bottom <= box.bottom
    })
  }, text)

/** Whether an element in the rendered note is wholly in the frame's view. */
const inFrameView = (element: Locator) =>
  element.evaluate((node) => {
    const at = node.getBoundingClientRect()
    return at.top >= 0 && at.bottom <= document.documentElement.clientHeight
  })

/** The number of the first paragraph wholly in view in the rendered note. */
const firstParagraphInFrame = (page: Page) =>
  frameOf(page)
    .locator(":root")
    .evaluate(() => {
      const shown = [...document.querySelectorAll("p")].find((node) => node.getBoundingClientRect().top >= 0)
      return Number(/^Paragraph (\d+) /.exec(shown?.textContent ?? "")?.[1])
    })

/** The number of the first paragraph whose first line is wholly in view in the source editor. */
const firstParagraphInSource = (page: Page) =>
  sourceEditor(page).evaluate((editor) => {
    const top = editor.getBoundingClientRect().top
    const starts = [...editor.querySelectorAll(".view-line")]
      .map((row) => ({ top: row.getBoundingClientRect().top, text: (row.textContent ?? "").replaceAll(" ", " ") }))
      .filter((row) => row.top >= top && /^Paragraph \d+ /.test(row.text))
      .sort((a, b) => a.top - b.top)
    return Number(/^Paragraph (\d+) /.exec(starts[0]?.text ?? "")?.[1])
  })

/** Put the rendered note's caret at the start of paragraph n, then `right` characters on. */
async function caretInRendered(page: Page, n: number, right: number) {
  const deep = paragraph(page, n)
  await deep.scrollIntoViewIfNeeded()
  await deep.click({ position: { x: 2, y: 4 } })
  await page.keyboard.press("Home")
  for (let step = 0; step < right; step++) await page.keyboard.press("ArrowRight")
}

/**
 * Scroll the source editor down with the wheel until `done`, a little at a
 * time: the editor moves Chromium's wheel events a fixed step each.
 */
async function scrollSource(page: Page, done: () => Promise<boolean>) {
  await sourceEditor(page).hover()
  for (let step = 0; step < 150 && !(await done()); step++) await page.mouse.wheel(0, 100)
  expect(await done()).toBe(true)
}

/** Scroll the source editor until paragraph n starts in view, and put the caret at its start, then `right` characters on. */
async function caretInSource(page: Page, n: number, right: number) {
  await scrollSource(page, () => sourceShows(page, `Paragraph ${n} of`))
  await sourceLine(page, n).click({ position: { x: 1, y: 4 } })
  for (let step = 0; step < right; step++) await page.keyboard.press("ArrowRight")
}

/** Save from the source editor, and the text the server then has. */
async function savedText(page: Page, fake: FakeSupabase, id: string) {
  await page.keyboard.press("ControlOrMeta+s")
  await quiet(fake, 1_500)
  return fake.server.content(id, PATH)
}

function journeys() {
  test("the caret in Rendered is where Source opens: in view, with the keyboard", async ({ page }) => {
    const { fake, id } = await openNote(page)
    await caretInRendered(page, 45, "Paragraph ".length)

    await showView(page, "Source")
    await expect.poll(() => sourceShows(page, "Paragraph 45 of")).toBe(true)
    await page.keyboard.type("XYZ")
    expect(await savedText(page, fake, id)).toBe(NOTE.replace("Paragraph 45 ", "Paragraph XYZ45 "))
  })

  test("a selection in Rendered is selected in Source", async ({ page }) => {
    const { fake, id } = await openNote(page)
    await caretInRendered(page, 45, 0)
    for (let step = 0; step < "Paragraph".length; step++) await page.keyboard.press("Shift+ArrowRight")

    await showView(page, "Source")
    await expect.poll(() => sourceShows(page, "Paragraph 45 of")).toBe(true)
    await page.keyboard.type("Section")
    expect(await savedText(page, fake, id)).toBe(NOTE.replace("Paragraph 45 ", "Section 45 "))
  })

  test("with no caret in Rendered, Source shows the text that was at its top", async ({ page }) => {
    await openNote(page)
    await page.locator(FRAME).hover()
    await page.mouse.wheel(0, 1500)
    await expect.poll(() => firstParagraphInFrame(page)).toBeGreaterThan(10)
    await page.waitForTimeout(300)
    const top = await firstParagraphInFrame(page)

    await showView(page, "Source")
    await expect.poll(() => sourceShows(page, `Paragraph ${top} of`)).toBe(true)
  })

  test("the caret in Source is where Rendered opens: in view, with the keyboard", async ({ page }) => {
    await openNote(page)
    await showView(page, "Source")
    await caretInSource(page, 45, "Paragraph ".length)

    await showView(page, "Rendered")
    await expect(frameOf(page).getByRole("textbox", { name: "Rendered document" })).toBeFocused()
    await expect.poll(() => inFrameView(paragraph(page, 45))).toBe(true)
    await page.keyboard.type("XYZ")
    await expect(paragraph(page, 45)).toHaveText(line(45).replace("Paragraph ", "Paragraph XYZ"))
  })

  test("a selection in Source is selected in Rendered", async ({ page }) => {
    await openNote(page)
    await showView(page, "Source")
    await caretInSource(page, 45, 0)
    for (let step = 0; step < "Paragraph".length; step++) await page.keyboard.press("Shift+ArrowRight")

    await showView(page, "Rendered")
    await expect(frameOf(page).getByRole("textbox", { name: "Rendered document" })).toBeFocused()
    await expect.poll(() => inFrameView(paragraph(page, 45))).toBe(true)
    await page.keyboard.type("Section")
    await expect(paragraph(page, 45)).toHaveText(line(45).replace("Paragraph ", "Section "))
  })

  test("with no caret in Source, Rendered shows the text that was at its top", async ({ page }) => {
    await openNote(page)
    await showView(page, "Source")
    await scrollSource(page, async () => (await firstParagraphInSource(page)) > 30)
    const top = await firstParagraphInSource(page)

    await showView(page, "Rendered")
    await expect.poll(() => inFrameView(paragraph(page, top))).toBe(true)
  })
}

journeys()

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  journeys()
})

import AxeBuilder from "./axe.ts"
import { expect, test, type Locator, type Page } from "./fixtures.ts"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { recordFrameMessages, releaseTransactions } from "./rendered-support.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

// Editing notes in a project: the source and rendered views, saves on this
// device that sync to the stand-in server, drafts that survive reloads and
// leaving, a file changed in two places, and a section an agent adds to the
// open note writing in.

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

// Each journey loads the full editor (Monaco and the note frame), which is slow on small CI machines.
test.describe.configure({ timeout: 60_000 })

async function openProject(page: Page, files: Record<string, string>, path?: string, phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  // Opening downloads and syncs first, which takes longer on a cold start.
  // On a phone the open file fills the screen; its Back button leads to the files screen.
  if (phone) await expect(page.getByRole("button", { name: "Back to files and projects" })).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

const serverContent = (fake: FakeSupabase, id: string, path: string) => fake.server.content(id, path)
/**
 * Wait until the workbench has remembered `path` among its open tabs. It saves
 * them only after its first file list arrives, so a navigation straight after
 * opening a file could otherwise land before `path` was remembered.
 */
async function remembered(page: Page, path: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (path) =>
          Object.keys(localStorage).some(
            (key) => key.endsWith("elaborating.tabs.v1") && (JSON.parse(localStorage.getItem(key) ?? "{}").openPaths ?? []).includes(path),
          ),
        path,
      ),
    )
    .toBe(true)
}

const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

/** Put the caret at the end of the visible source editor and type. */
async function typeAtEnd(page: Page, text: string) {
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
}

/** Select a file's tab, then type at the end of that tab's own code editor and check the text arrived. */
async function typeInTab(page: Page, path: string, text: string) {
  await page.getByRole("tab", { name: path }).click()
  await expect(page.getByRole("tab", { name: path })).toHaveAttribute("aria-selected", "true")
  const editor = page.getByRole("tabpanel", { name: path }).locator(".monaco-editor:visible .view-lines")
  await editor.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
  await expect(editor).toContainText(text)
}

test("typing in the source view saves on this device and reaches the server", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# Title\n" }, "a.md")
  await typeAtEnd(page, "Typed here.")
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes" })).toHaveCount(0)
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("# Title\nTyped here.")
})

/** Open a.md's rendered view and type at the end of its paragraph, with the edit held back from the source until `releaseTransactions`. */
async function typeHeldInRendered(page: Page) {
  await recordFrameMessages(page)
  const project = await openProject(page, { "a.md": "# Title\n\nFirst paragraph.\n" }, "a.md")
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  await frame.locator("p").filter({ hasText: /^First paragraph\.$/ }).click()
  await page.keyboard.press("End")
  await page.evaluate(() => {
    window.transactionGate.enabled = true
  })
  await page.keyboard.type(" More.")
  await page.waitForFunction(() => window.transactionGate.held.length > 0)
  await expect(frame.locator("p").filter({ hasText: /^First paragraph\. More\.$/ })).toBeVisible()
  return project
}

test("an edit in the rendered view saves to the same file, from a menu opened while the edit was finishing, whose Save and Duplicate wait for it", async ({ page }) => {
  const { fake, id } = await typeHeldInRendered(page)
  await page.getByRole("button", { name: "File actions" }).click()
  const save = page.getByRole("menuitem", { name: "Save" })
  const duplicate = page.getByRole("menuitem", { name: "Duplicate" })
  await expect(save).toBeDisabled()
  await expect(duplicate).toBeDisabled()
  // The open menu follows the file: Save and Duplicate turn on once the edit has finished.
  await releaseTransactions(page)
  await expect(save).toBeEnabled()
  await expect(duplicate).toBeEnabled()
  await save.click()
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("# Title\n\nFirst paragraph. More.\n")
})

test("Save pressed while a rendered edit is finishing saves it once the edit has finished", async ({ page }) => {
  const { fake, id } = await typeHeldInRendered(page)
  await page.keyboard.press("ControlOrMeta+s")
  // The frame passes the shortcut up while the edit is still held back.
  await page.waitForFunction(() => window.frameMessages.some((message) => message.kind === "shortcut"))
  expect(serverContent(fake, id, "a.md")).toBe("# Title\n\nFirst paragraph.\n")
  await releaseTransactions(page)
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("# Title\n\nFirst paragraph. More.\n")
  await expect(page.getByRole("tab", { name: "a.md", exact: true })).toBeVisible()
  await expect(page.getByText("Finishing edit…")).toHaveCount(0)
})

/** Duplicate was asked for while the edit is held back: no copy until the edit has finished, then a copy that has it. */
async function duplicatedOnceEditFinished(page: Page, fake: FakeSupabase, id: string) {
  // A copy made at once, without the edit, would be open by now.
  await page.waitForTimeout(500)
  await expect(page.getByRole("tab", { name: "a copy.md" })).toHaveCount(0)
  await releaseTransactions(page)
  await expect(page.getByRole("tab", { name: "a copy.md" })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => serverContent(fake, id, "a copy.md")).toBe("# Title\n\nFirst paragraph. More.\n")
}

test("⌘D / Ctrl+D pressed in the rendered view while an edit is finishing duplicates the file once the edit has finished", async ({ page }) => {
  const { fake, id } = await typeHeldInRendered(page)
  await page.keyboard.press("ControlOrMeta+d")
  // The frame passes the shortcut up while the edit is still held back.
  await page.waitForFunction(() => window.frameMessages.some((message) => message.kind === "shortcut"))
  await duplicatedOnceEditFinished(page, fake, id)
})

test("Duplicate in the command palette while a rendered edit is finishing duplicates the file once the edit has finished", async ({ page }) => {
  const { fake, id } = await typeHeldInRendered(page)
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByLabel("Search commands").first().fill("Duplicate")
  await page.keyboard.press("Enter")
  await duplicatedOnceEditFinished(page, fake, id)
})

test("unsaved edits survive a reload, and are not sent to the server", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "saved\n" }, "a.md")
  await typeAtEnd(page, "draft")
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes" })).toBeVisible()
  await page.waitForTimeout(300)
  await page.reload()
  // The reload loads the editor again, as slowly as the first open.
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes" })).toBeVisible({ timeout: 15_000 })
  await expect(editorText(page)).toContainText("saveddraft")
  expect(serverContent(fake, id, "a.md")).toBe("saved\n")
})

/** Whether leaving the page now would ask first: the app cancels `beforeunload` while a file has unsaved changes. */
const warnsOnLeave = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })

test("undoing back to the saved text clears the unsaved state, and a reload restores no draft", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "saved\n" }, "a.md")
  const mark = page.getByRole("tab", { name: "a.md, unsaved changes" })
  await typeAtEnd(page, "draft")
  await expect(mark).toBeVisible()
  await expect(page.getByRole("main").getByText("Unsaved changes", { exact: true })).toBeVisible()
  expect(await warnsOnLeave(page)).toBe(true)

  await page.keyboard.press("ControlOrMeta+z")
  await expect(editorText(page)).not.toContainText("draft")
  await expect(mark).toHaveCount(0)
  await expect(page.getByRole("main").getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  await expect(page).not.toHaveTitle(/^•/)
  expect(await warnsOnLeave(page)).toBe(false)

  // Drafts are kept in the background, as in the journey above.
  await page.waitForTimeout(300)
  await page.reload()
  // The reload loads the editor again, as slowly as the first open.
  await expect(editorText(page)).toContainText("saved", { timeout: 15_000 })
  await expect(editorText(page)).not.toContainText("draft")
  await expect(mark).toHaveCount(0)
  expect(serverContent(fake, id, "a.md")).toBe("saved\n")
})

test("an edit in the rendered view undone with Ctrl+Z there clears the unsaved state, and a reload restores no draft", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# Title\n\nFirst paragraph.\n" }, "a.md")
  const mark = page.getByRole("tab", { name: "a.md, unsaved changes" })
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]')
  const paragraph = frame.locator("p").filter({ hasText: /^First paragraph\./ })
  await paragraph.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" More.")
  await expect(paragraph).toHaveText("First paragraph. More.")
  await expect(mark).toBeVisible()

  await page.keyboard.press("ControlOrMeta+z")
  await expect(paragraph).toHaveText("First paragraph.")
  await expect(mark).toHaveCount(0)
  await expect(page.getByRole("main").getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  expect(await warnsOnLeave(page)).toBe(false)

  await page.waitForTimeout(300)
  await page.reload()
  // The note opens in the view it was left in.
  await expect(paragraph).toHaveText("First paragraph.", { timeout: 15_000 })
  await expect(mark).toHaveCount(0)
  expect(serverContent(fake, id, "a.md")).toBe("# Title\n\nFirst paragraph.\n")
})

/**
 * From now on, records every frame how many characters of the paragraphs
 * with these texts the note's frame does not draw (null while one is not
 * there) and whether it shows the caret that writes; and, on the page,
 * whether the note says it has unsaved changes, how many characters Source
 * does not draw, whether it shows its caret, the line the caret is on, and
 * Source's line numbers, shown or not.
 */
async function watchWriting(page: Page, texts: string[]) {
  await noteFrame(page).locator("body").evaluate((_, texts) => {
    const hidden = (root: Element) => {
      let count = 0
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (getComputedStyle(node.parentElement!).visibility !== "visible") count += node.textContent!.length
      return count
    }
    const frames: { hidden: (number | null)[]; caret: boolean }[] = []
    Object.assign(window, { writing: frames })
    const tick = () => {
      const paragraphs = [...document.querySelectorAll(".ProseMirror p")]
      frames.push({
        hidden: texts.map((text) => {
          const paragraph = paragraphs.find((element) => element.textContent === text)
          return paragraph ? hidden(paragraph) : null
        }),
        caret: document.querySelector(".ProseMirror .type-in-caret") !== null,
      })
      if (frames.length < 1_500) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, texts)
  await page.evaluate(() => {
    const frames: SourceFrame[] = []
    Object.assign(window, { writing: frames })
    const tick = () => {
      let hidden = 0
      for (const lines of document.querySelectorAll(".monaco-editor .view-lines")) {
        const walker = document.createTreeWalker(lines, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          if (getComputedStyle(node.parentElement!).visibility !== "visible") hidden += node.textContent!.length
      }
      // A line's number is drawn at the top of its first row, a wrapped line's rows below it.
      const numbers = [...document.querySelectorAll<HTMLElement>(".monaco-editor .margin-view-overlays > div")]
        .flatMap((line) => {
          const number = line.querySelector(".line-numbers")
          return number?.textContent ? [{ line: Number(number.textContent), top: parseFloat(line.style.top), shown: getComputedStyle(number).visibility === "visible" }] : []
        })
        .sort((a, b) => a.top - b.top)
      const caretRow = document.querySelector(".monaco-editor .source-writing-caret")?.closest<HTMLElement>(".view-line")
      const caretTop = caretRow ? parseFloat(caretRow.style.top) : NaN
      frames.push({
        unsaved: Boolean(document.querySelector(".wb-session [aria-live]")?.textContent?.includes("Unsaved changes")),
        hidden,
        caret: document.querySelector(".monaco-editor .source-writing-caret") !== null,
        caretLine: numbers.filter(({ top }) => top <= caretTop).at(-1)?.line ?? null,
        numbers: numbers.map(({ line, shown }) => ({ line, shown })),
      })
      if (frames.length < 1_500) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
const renderedWriting = (page: Page) =>
  noteFrame(page).locator("body").evaluate(() => (window as unknown as { writing: { hidden: (number | null)[]; caret: boolean }[] }).writing)
type SourceFrame = { unsaved: boolean; hidden: number; caret: boolean; caretLine: number | null; numbers: { line: number; shown: boolean }[] }
const sourceWriting = (page: Page) => page.evaluate(() => (window as unknown as { writing: SourceFrame[] }).writing)
const allNumbersShown = (frame: SourceFrame | undefined) => frame?.numbers.every(({ shown }) => shown)
/** The last frame each view drew. */
const lastRendered = (page: Page) =>
  noteFrame(page).locator("body").evaluate(() => (window as unknown as { writing: { hidden: (number | null)[]; caret: boolean }[] }).writing.at(-1))
const lastSource = (page: Page) => page.evaluate(() => (window as unknown as { writing: SourceFrame[] }).writing.at(-1))

test("a paragraph an agent adds to the open note types in behind a caret in Rendered and Source, leaves nothing unsaved or to undo, and with reduced motion appears at once", async ({ page }) => {
  const NOTE = "# Launch plan\n\nWhat ships on day one.\n"
  const SLOW = "The import is slow: every row is checked twice, once as it is read and again before it is saved, so a large file can take several minutes to finish."
  const WITH_SLOW = `${NOTE}\n${SLOW}\n`
  // The note takes three of an agent's versions: more than the default test time on a busy machine.
  test.slow()
  // The page's clock, which this test stops for the clicks below.
  await page.clock.install()
  const { fake, id } = await openProject(page, { "notes/launch.md": NOTE }, "notes/launch.md")
  await page.getByRole("button", { name: "Split", exact: true }).click()
  const frame = noteFrame(page)
  await expect(frame.getByRole("heading", { name: "Launch plan" })).toBeVisible({ timeout: 15_000 })
  await expect(editorText(page)).toContainText("What ships on day one.")
  const saves = fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length

  // The agent adds a paragraph (append_to_note), which reaches the open note through Realtime.
  await watchWriting(page, ["What ships on day one.", SLOW])
  await agentSaves(fake, id, WITH_SLOW)
  // All of it shows, shortly after, with no caret left, and every line's number.
  await expect
    .poll(async () => {
      const [rendered, source] = [(await renderedWriting(page)).at(-1), (await sourceWriting(page)).at(-1)]
      return [rendered?.hidden[1], rendered?.caret, source?.hidden, source?.caret, allNumbersShown(source)]
    }, { timeout: 10_000 })
    .toEqual([0, false, 0, false, true])
  // Part way through, some of it showed, the rest was hidden in its place, and a caret wrote it, in both views.
  const rendered = await renderedWriting(page)
  const source = await sourceWriting(page)
  expect(rendered.some(({ hidden: [, paragraph], caret }) => paragraph !== null && paragraph > 0 && paragraph < SLOW.length && caret)).toBe(true)
  expect(source.some(({ hidden, caret }) => hidden > 0 && hidden < SLOW.length && caret)).toBe(true)
  // Source had every line of the end from the start, and a line's number showed once the caret reached the line.
  const writing = source.filter(({ caret }) => caret)
  const lines = (frame: SourceFrame) => frame.numbers.map(({ line }) => line).join()
  expect(new Set(writing.map(lines))).toEqual(new Set([lines(source.at(-1)!)]))
  expect(writing.some(({ numbers }) => numbers.some(({ shown }) => !shown))).toBe(true)
  expect(writing.filter(({ caretLine, numbers }) => caretLine === null || numbers.some(({ line, shown }) => shown !== line <= caretLine))).toEqual([])
  // What was there before showed all along.
  expect(rendered.filter(({ hidden: [before] }) => before !== 0)).toEqual([])

  // The note took the saved version: nothing unsaved at any point, nothing saved again, and nothing to undo.
  expect(source.filter(({ unsaved }) => unsaved)).toEqual([])
  await expect(page.getByRole("tab", { name: "launch.md, unsaved changes" })).toHaveCount(0)
  await frame.getByText(SLOW).click()
  await page.keyboard.press("ControlOrMeta+z")
  await page.waitForTimeout(500)
  await expect(frame.getByText(SLOW)).toBeVisible()
  await expect(editorText(page)).toContainText("The import is slow")
  await expect(page.getByRole("tab", { name: "launch.md, unsaved changes" })).toHaveCount(0)
  expect((await sourceWriting(page)).filter(({ unsaved }) => unsaved)).toEqual([])
  expect(fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length).toBe(saves)
  expect(serverContent(fake, id, "notes/launch.md")).toBe(WITH_SLOW)

  // A click in a view while it writes shows the rest there at once. The page's clock (in the note's
  // frame too) stands still meanwhile and goes on a frame at a time, so the writing cannot finish by
  // itself however busy the machine: what shows after a click and a frame is the click's doing.
  const STEPS = `First, the rows are read in batches of a thousand. ${SLOW} Then each batch is checked once, and only what changed is saved again, which leaves the slow part to the rows that really did change since the last import.`
  const WITH_STEPS = `${WITH_SLOW}\n${STEPS}\n`
  // Any press in Source's text, or anywhere in Rendered, shows the rest: the mouse presses near the
  // top left of each, measured before, as a click on an element waits for frames the clock holds back.
  const sourceArea = (await page.locator(".monaco-editor:visible .editor-scrollable").first().boundingBox())!
  const renderedArea = (await page.locator('iframe[title="Isolated document preview"]').boundingBox())!
  await watchWriting(page, [STEPS])
  // The clock runs until the pause reaches the page, and pauseAt refuses a time the clock has passed,
  // as a second ahead could be on a busy machine. The page's date is held at the time asked for first,
  // so it cannot pass it: the clock stops where it is, and then its date goes on with it again. A jump
  // ahead would fire every timer due by then, and an hour's (local-project.spec.ts) would leave the
  // session expired by the page's clock, its token refreshed over and over while the test looks.
  const now = await page.evaluate(() => Date.now())
  await page.clock.setFixedTime(now)
  await page.clock.pauseAt(now)
  await page.clock.setSystemTime(now)
  const frames = (count: number) => page.clock.runFor(16 * count)
  await agentSaves(fake, id, WITH_STEPS)
  // A few frames at a time until both views write it, well short of the time writing it takes (writeIn.ts).
  await expect
    .poll(async () => {
      await frames(6)
      return [(await lastSource(page))?.hidden ?? 0, (await lastRendered(page))?.hidden[0] ?? 0].every((hidden) => hidden > 0)
    }, { intervals: [10] })
    .toBe(true)
  // Source first, while it keeps the writing in view: it draws only the lines in view, and a click
  // in Rendered brings Source to the line clicked.
  await page.mouse.click(sourceArea.x + 20, sourceArea.y + 10)
  await frames(3)
  expect(await lastSource(page)).toMatchObject({ hidden: 0, caret: false })
  expect(allNumbersShown(await lastSource(page))).toBe(true)
  expect((await lastRendered(page))?.hidden[0]).toBeGreaterThan(0)
  await page.mouse.click(renderedArea.x + 40, renderedArea.y + 40)
  await frames(3)
  expect(await lastRendered(page)).toEqual({ hidden: [0], caret: false })
  await page.clock.resume()

  // With reduced motion the next paragraph appears at once, in both views.
  await page.emulateMedia({ reducedMotion: "reduce" })
  await watchWriting(page, ["Ada runs the launch."])
  await agentSaves(fake, id, `${WITH_STEPS}\nAda runs the launch.\n`)
  await expect(frame.getByText("Ada runs the launch.")).toBeVisible()
  // Twenty frames with it there, any of which would catch it on the way in.
  await expect.poll(async () => (await renderedWriting(page)).filter(({ hidden: [paragraph] }) => paragraph !== null).length).toBeGreaterThan(20)
  expect((await renderedWriting(page)).filter(({ hidden: [paragraph], caret }) => (paragraph !== null && paragraph > 0) || caret)).toEqual([])
  expect((await sourceWriting(page)).filter(({ unsaved, hidden, caret }) => unsaved || hidden > 0 || caret)).toEqual([])
})

// A note longer than either view in Split, and the section an agent adds to
// its end, which takes more room than the end of a view has below the note.
const FIELD_NOTES = `# Field notes\n\n${Array.from({ length: 40 }, (_, at) => `Paragraph ${at + 1} of the field notes.`).join("\n\n")}\n`
const WITH_RISKS = `${FIELD_NOTES}\n## Risks\n\nThe import is slow.\n\nThe export is slower.\n\nNobody has tried a restore.\n`
const noteFrame = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]')
/** How far the note's frame is scrolled, and how far it can be. */
const frameScroll = (page: Page) =>
  noteFrame(page).locator("body").evaluate(() => ({ top: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight }))
/** The lines Source shows, in order. */
const sourceLines = async (page: Page) => (await editorText(page).locator(".view-line").allTextContents()).sort()

/**
 * Open the long note in Split and turn the mouse wheel over both views, a
 * notch at a time: down to the end, then `back` notches up again.
 */
async function readLongNote(page: Page, back = 0) {
  const project = await openProject(page, { "notes/field.md": FIELD_NOTES }, "notes/field.md")
  await page.getByRole("button", { name: "Split", exact: true }).click()
  await expect(noteFrame(page).getByRole("heading", { name: "Field notes" })).toBeVisible({ timeout: 15_000 })
  await expect(editorText(page)).toContainText("# Field notes")
  for (const view of [page.locator('iframe[title="Isolated document preview"]'), page.locator(".monaco-editor:visible").first()]) {
    const box = (await view.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let notch = 0; notch < 60; notch++) await page.mouse.wheel(0, 200)
    await page.waitForTimeout(300)
    for (let notch = 0; notch < back; notch++) await page.mouse.wheel(0, -200)
  }
  await expect
    .poll(async () => {
      const { top, max } = await frameScroll(page)
      return max > 400 && (back ? top < max - 300 : top >= max - 1)
    })
    .toBe(true)
  if (back) await expect(editorText(page)).not.toContainText("Paragraph 40 of the field notes.")
  else await expect(editorText(page)).toContainText("Paragraph 40 of the field notes.")
  return project
}

async function agentAddsRisks(fake: FakeSupabase, id: string) {
  await fake.agentChanges.save(person.id, id, "notes/field.md", WITH_RISKS)
  fake.signal(id, fake.server.projects.get(id)!.revision)
}

test("a note read to its end brings a section an agent adds into view, in Rendered and in Source", async ({ page }) => {
  const { fake, id } = await readLongNote(page)
  await agentAddsRisks(fake, id)
  // All of the new section comes into view: its heading, through to its last paragraph.
  for (const block of [noteFrame(page).getByRole("heading", { name: "Risks" }), noteFrame(page).getByText("Nobody has tried a restore.")]) {
    await expect(block).toBeAttached()
    await expect.poll(() => block.evaluate((element) => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
  }
  await expect(editorText(page)).toContainText("## Risks")
  await expect(editorText(page)).toContainText("Nobody has tried a restore.")
})

test("a note scrolled up to read stays where it is when an agent adds a section, in Rendered and in Source", async ({ page }) => {
  const { fake, id } = await readLongNote(page, 3)
  // Settled where the reader left it.
  await expect
    .poll(async () => {
      const before = (await frameScroll(page)).top
      await page.waitForTimeout(250)
      return (await frameScroll(page)).top === before
    })
    .toBe(true)
  const scrolled = await frameScroll(page)
  const lines = await sourceLines(page)
  await agentAddsRisks(fake, id)
  await expect(noteFrame(page).getByRole("heading", { name: "Risks" })).toBeAttached()
  // Time for a view to have followed it, had it.
  await page.waitForTimeout(1_000)
  expect((await frameScroll(page)).top).toBe(scrolled.top)
  expect(await sourceLines(page)).toEqual(lines)
})

// The person's caret, after "What ships" in the plan's paragraph, when an
// agent's save reaches the open note: what they type next goes there.
const PLAN = "# Launch plan\n\nWhat ships on day one.\n"
const sourceLine = (page: Page, text: string) => page.locator(".monaco-editor:visible .view-line").filter({ hasText: text })

/** Click the line, then put the caret after its first two words with the keys. */
async function caretAfterWhatShips(page: Page, line: Locator) {
  await line.click()
  await page.keyboard.press("Home")
  for (let step = 0; step < "What ships".length; step++) await page.keyboard.press("ArrowRight")
}

async function agentSaves(fake: FakeSupabase, id: string, content: string) {
  await fake.agentChanges.save(person.id, id, "notes/launch.md", content)
  fake.signal(id, fake.server.projects.get(id)!.revision)
}

test("a rendered note behind another tab takes an agent's save, and shows it when the person goes back, not a failed preview", async ({ page }) => {
  const { fake, id } = await openProject(page, { "notes/launch.md": PLAN, "notes/other.md": "# Other\n" }, "notes/launch.md")
  const other = page.getByRole("tab", { name: "notes/other.md" })
  await page.getByRole("button", { name: "notes/other.md", exact: true }).click()
  await expect(other).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "notes/launch.md" }).click()
  await page.getByRole("button", { name: "Rendered" }).click()
  // The note's frame, also while its tab is hidden.
  const note = page.getByRole("tabpanel", { name: "notes/launch.md", includeHidden: true }).frameLocator('iframe[title="Isolated document preview"]')
  // The caret goes into the note, then the other tab hides its frame with
  // its text focused, where Firefox gives the frame no selection.
  await note.getByText("What ships on day one.").click()
  await other.click()
  await expect(other).toHaveAttribute("aria-selected", "true")
  await agentSaves(fake, id, `${PLAN}\n## Risks\n\nThe import is slow.\n`)
  await expect(note.getByText("The import is slow.")).toBeAttached()
  await page.getByRole("tab", { name: "notes/launch.md" }).click()
  await expect(note.getByRole("heading", { name: "Risks" })).toBeVisible()
  await expect(note.getByText("The import is slow.")).toBeVisible()
  await expect(page.getByText(/Preview failed/)).toHaveCount(0)
})

test("the caret in a rendered note stays where it was when an agent adds a section, and what the person types goes there", async ({ page }) => {
  const { fake, id } = await openProject(page, { "notes/launch.md": PLAN }, "notes/launch.md")
  await page.getByRole("button", { name: "Rendered" }).click()
  await caretAfterWhatShips(page, noteFrame(page).getByText("What ships on day one."))
  await agentSaves(fake, id, `${PLAN}\n## Risks\n\nThe import is slow.\n`)
  await expect(noteFrame(page).getByRole("heading", { name: "Risks" })).toBeVisible()
  await page.keyboard.type("X")
  await expect(noteFrame(page).getByText("What shipsX on day one.")).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "notes/launch.md")).toBe("# Launch plan\n\nWhat shipsX on day one.\n\n## Risks\n\nThe import is slow.\n")
})

test("the caret in a note's source stays where it was when an agent adds a section, and what the person types goes there", async ({ page }) => {
  const { fake, id } = await openProject(page, { "notes/launch.md": PLAN }, "notes/launch.md")
  await caretAfterWhatShips(page, sourceLine(page, "What ships on day one."))
  await agentSaves(fake, id, `${PLAN}\n## Risks\n\nThe import is slow.\n`)
  await expect(editorText(page)).toContainText("The import is slow.")
  await page.keyboard.type("X")
  await expect(editorText(page)).toContainText("What shipsX on day one.")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "notes/launch.md")).toBe("# Launch plan\n\nWhat shipsX on day one.\n\n## Risks\n\nThe import is slow.\n")
})

test("a paragraph an agent adds above the caret leaves it after the same word, in Rendered and in Source, and the view without focus does not take it", async ({ page }) => {
  const { fake, id } = await openProject(page, { "notes/launch.md": PLAN }, "notes/launch.md")
  await page.getByRole("button", { name: "Split", exact: true }).click()
  // In Rendered, above a paragraph that starts with the same words.
  await caretAfterWhatShips(page, noteFrame(page).getByText("What ships on day one."))
  await agentSaves(fake, id, "# Launch plan\n\nWhat ships first is the import.\n\nWhat ships on day one.\n")
  await expect(noteFrame(page).getByText("What ships first is the import.")).toBeVisible()
  await page.keyboard.type("X")
  await expect(noteFrame(page).getByText("What shipsX on day one.")).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  const first = "# Launch plan\n\nWhat ships first is the import.\n\nWhat shipsX on day one.\n"
  await expect.poll(() => serverContent(fake, id, "notes/launch.md")).toBe(first)
  // In Source, with the rendered note's caret where it was.
  await caretAfterWhatShips(page, sourceLine(page, "What shipsX on day one."))
  await agentSaves(fake, id, first.replace("What shipsX", "What ships next is the export.\n\nWhat shipsX"))
  await expect(editorText(page)).toContainText("What ships next is the export.")
  await page.keyboard.type("Y")
  await expect(editorText(page)).toContainText("What shipsYX on day one.")
  await page.keyboard.press("ControlOrMeta+s")
  await expect
    .poll(() => serverContent(fake, id, "notes/launch.md"))
    .toBe("# Launch plan\n\nWhat ships first is the import.\n\nWhat ships next is the export.\n\nWhat shipsYX on day one.\n")
})

test("leaving the project keeps unsaved edits, and they are there on return", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "saved\n" }, "a.md")
  await typeAtEnd(page, "draft")
  await page.getByRole("button", { name: /, project menu$/ }).click()
  await page.getByRole("menuitem", { name: "All projects" }).click()
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await page.getByRole("link", { name: "Notes" }).click()
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes" })).toBeVisible()
  await expect(editorText(page)).toContainText("saveddraft")
  expect(serverContent(fake, id, "a.md")).toBe("saved\n")
})

for (const choice of ["mine", "theirs", "both"] as const) {
  test(`a file changed in two places can keep ${choice}`, async ({ page, appErrors }) => {
    appErrors.expect("a.md was changed on another device too, so its sync stopped.")
    appErrors.expect("Changed in two places: choose which version to keep")
    const { fake, id } = await openProject(page, { "a.md": "base\n" }, "a.md")
    // Save here while the server cannot be reached...
    fake.offline = true
    await typeAtEnd(page, "mine")
    await page.keyboard.press("ControlOrMeta+s")
    await quiet(fake)
    // ...while another device changes the same file.
    const remote = fake.server.remote(person.id)
    const version = fake.server.projects.get(id)!.files.get("a.md")!.version
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.md", content: "theirs\n", base_version: version }])
    fake.offline = false
    await page.getByRole("button", { name: "Account and settings" }).click()
    await page.getByRole("menuitem", { name: "Sync now" }).click()

    await expect(page.getByText("was changed on another device too")).toBeVisible()
    await page.getByRole("button", { name: `Keep ${choice}` }).click()
    if (choice === "mine") {
      await expect.poll(() => serverContent(fake, id, "a.md")).toBe("base\nmine")
    } else if (choice === "theirs") {
      await expect(editorText(page)).toContainText("theirs")
      await expect.poll(() => serverContent(fake, id, "a.md")).toBe("theirs\n")
    } else {
      await expect.poll(() => serverContent(fake, id, "a (my copy).md")).toBe("base\nmine")
      expect(serverContent(fake, id, "a.md")).toBe("theirs\n")
    }
    await expect(page.getByText("was changed on another device too")).toHaveCount(0)
  })
}

test("a new note from the menu is saved under a new name", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "a\n" })
  await page.getByRole("button", { name: "New file" }).click()
  await page.getByRole("menuitem", { name: "New note" }).click()
  // It asks for a name first; Enter takes the one proposed.
  await expect(page.getByRole("textbox", { name: /^Name of the new note in / })).toHaveValue(/^untitled/)
  await page.keyboard.press("Enter")
  const tab = page.getByRole("tab", { name: /^untitled/ })
  await expect(tab).toBeVisible()
  const path = (await tab.getAttribute("aria-label"))!
  await typeAtEnd(page, "A new note.")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, path)).toBe("A new note.")
})

test("open tabs come back after a reload, with the same one active", async ({ page }) => {
  // Three editor loads, each allowed 15 seconds, can outlast the default test time on a busy machine.
  test.slow()
  const { id } = await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await remembered(page, "a.md")
  // Each navigation loads the editor again, as slowly as the first open.
  await page.goto(projectUrl(id, "b.md"))
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await remembered(page, "b.md")
  await page.reload()
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(projectUrl(id, "b.md"))
})

test("closing a tab from the keyboard works, and an unsaved one asks first", async ({ page }) => {
  // Two editor loads and a dialog; see the journey above.
  test.slow()
  await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await remembered(page, "a.md")
  await page.goto(page.url().replace(/a\.md$/, "b.md"))
  // The navigation loads the editor again, as slowly as the first open.
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible()
  await page.getByRole("tab", { name: "b.md" }).focus()
  await page.keyboard.press("Delete")
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true")

  await typeAtEnd(page, "!")
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("tab", { name: "a.md" }).focus()
  await page.keyboard.press("Delete")
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible()
})

// Firefox stops a page's downloads as it starts to leave for another address,
// so the code editor's code, still downloading, fails there while the page is
// on screen (lib/moduleLoader.ts). The page being left says nothing of it.
test("leaving a note while its code editor is still downloading shows no error on it", async ({ page, appErrors }) => {
  // Two editor loads; see the journey above.
  test.slow()
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let asked = false
  await page.route(/\/assets\/MonacoSourceEditor-[\w-]+\.js$/, async (route) => {
    if (asked) return route.continue()
    asked = true
    await released
    await route.continue().catch(() => {})
  })
  const { id } = await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await expect.poll(() => asked).toBe(true)
  await page.goto(projectUrl(id, "b.md"))
  release()
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  expect(appErrors.unexpected()).toEqual([])
})

test("a code editor whose code does not download says so", async ({ page, appErrors }) => {
  appErrors.expect("The code editor could not load.")
  await page.route(/\/assets\/MonacoSourceEditor-[\w-]+\.js$/, (route) => route.abort())
  await openProject(page, { "a.md": "a\n" }, "a.md")
  await expect(page.getByRole("alert").filter({ hasText: "The code editor could not load." })).toBeVisible()
})

// The same for code the app does not load itself: the code editor asks for
// its Markdown highlighting as the note opens, and does not catch a failure.
// As the page is left that failure is not an error; on a page that stays it
// still is.
test("leaving a note while its Markdown highlighting is still downloading throws nothing there", async ({ page, appErrors }) => {
  // Two editor loads; see the journey above.
  test.slow()
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let asked = false
  await page.route(/\/assets\/markdown-[\w-]+\.js$/, async (route) => {
    if (asked) return route.continue()
    asked = true
    await released
    await route.continue().catch(() => {})
  })
  const { id } = await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await expect.poll(() => asked, { timeout: 15_000 }).toBe(true)
  await page.goto(projectUrl(id, "b.md"))
  release()
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
  expect(appErrors.unexpected()).toEqual([])
})

test("Markdown highlighting that does not download, on a note that stays open, is still an uncaught error", async ({ page, appErrors }) => {
  await page.route(/\/assets\/markdown-[\w-]+\.js$/, (route) => route.abort())
  await openProject(page, { "a.md": "a\n" }, "a.md")
  await expect.poll(() => appErrors.unexpected().some((error) => error.kind === "uncaught" && /dynamically imported module/.test(error.text)), { timeout: 15_000 }).toBe(true)
  appErrors.expect(/dynamically imported module/)
})

/** Open a file from the explorer, in a new tab, without reloading the page. */
async function openFromExplorer(page: Page, path: string) {
  await expect(page.getByRole("navigation", { name: "Workspace files" }).first()).toBeVisible()
  await page.getByRole("button", { name: path, exact: true }).click()
  await expect(page.getByRole("tab", { name: path })).toHaveAttribute("aria-selected", "true")
}

test("Ctrl+S saves the note whose editor has focus, with two notes open", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  // b.md's editor is created second, after a.md's.
  await openFromExplorer(page, "b.md")
  await page.getByRole("tab", { name: "a.md" }).click()
  await typeAtEnd(page, "first")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "a.md, unsaved changes" })).toHaveCount(0)
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("a\nfirst")

  await page.getByRole("tab", { name: "b.md" }).click()
  await typeAtEnd(page, "second")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "b.md")).toBe("b\nsecond")
  expect(serverContent(fake, id, "a.md")).toBe("a\nfirst")
})

test("Ctrl+S saves the note whose editor has focus, with a diagram's code open too", async ({ page }) => {
  // The diagram compiles with D2's 8 MB WebAssembly build.
  test.slow()
  const { fake, id } = await openProject(page, { "a.md": "a\n", "flow.d2": "x -> y\n" }, "a.md")
  await openFromExplorer(page, "flow.d2")
  await expect(page.getByText("Compiling diagram…")).toHaveCount(0, { timeout: 45_000 })
  // The code editor is created after the note's.
  await page.getByRole("group", { name: "Diagram view" }).getByRole("button", { name: "Code", exact: true }).click()
  await expect(page.locator(".monaco-editor:visible")).toBeVisible()

  // No Enter after a name: the suggestions it opens could take the key.
  await typeInTab(page, "flow.d2", "y -> z")
  await typeInTab(page, "a.md", "note")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => serverContent(fake, id, "a.md")).toBe("a\nnote")
  // The diagram, which has an unsaved code edit, was not saved instead.
  expect(serverContent(fake, id, "flow.d2")).toBe("x -> y\n")

  await typeInTab(page, "flow.d2", "")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tabpanel", { name: "flow.d2" }).getByText("Saved flow.d2 and its generated files.")).toBeVisible()
  await expect.poll(() => serverContent(fake, id, "flow.d2")).toBe("x -> y\ny -> z")
  expect(serverContent(fake, id, "a.md")).toBe("a\nnote")
})

test("clicking a tab's close mark closes it", async ({ page }) => {
  await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await openFromExplorer(page, "b.md")
  // The mark is a pointer target only (a tab list holds only tabs); it shows on hover.
  await page.getByRole("tab", { name: "a.md" }).hover()
  await page.getByRole("tab", { name: "a.md" }).locator('[data-slot="tab-close"]').click()
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true")
})

/**
 * A tab's width, the room after its name to the tab's end, and the room
 * between the end of its name and the left edge of "...".
 */
const tabBeside = (page: Page, name: string) =>
  page.getByRole("tab", { name }).evaluate((tab) => {
    const box = tab.getBoundingClientRect()
    const shown = tab.querySelector('[data-slot="tab-name"]')!.getBoundingClientRect()
    const button = document.querySelector("[data-tab-actions]")!.getBoundingClientRect()
    return { width: box.width, end: box.right - shown.right, room: button.left - shown.right }
  })

test("a tab's file actions open from ... on the active tab, and on right-click on any tab", async ({ page }) => {
  await openProject(page, { "a.md": "a\n", "b.md": "b\n" }, "a.md")
  await openFromExplorer(page, "b.md")
  const items = ["Save", "Duplicate", "Reload", "Export", "Format"]
  const menu = page.getByRole("menu", { name: "File actions" })
  const more = page.getByRole("button", { name: "File actions" })
  // "..." sits over the active tab's end, shown under the pointer and with
  // keyboard focus. The tab is sized to its name and keeps its width, and its
  // name ends before "...".
  await expect(more).toHaveCSS("opacity", "0")
  const { width, end } = await tabBeside(page, "b.md")
  expect(end).toBeCloseTo(10, 0)
  await page.getByRole("tab", { name: "b.md" }).hover()
  await expect(more).toHaveCSS("opacity", "1")
  expect((await tabBeside(page, "b.md")).width).toBe(width)
  expect((await tabBeside(page, "b.md")).room).toBeGreaterThanOrEqual(0)
  await more.click()
  for (const name of items) await expect(menu.getByRole("menuitem", { name })).toBeVisible()
  expect((await tabBeside(page, "b.md")).width).toBe(width)
  expect((await tabBeside(page, "b.md")).room).toBeGreaterThanOrEqual(0)
  await expect(menu.getByRole("menuitem")).toHaveCount(items.length)
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await page.getByRole("tab", { name: "b.md" }).focus()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "File actions" })).toBeFocused()
  // Right-click opens the same menu for that tab's file.
  await page.getByRole("tab", { name: "a.md" }).click({ button: "right" })
  for (const name of items) await expect(menu.getByRole("menuitem", { name })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
})

/**
 * Whether a tab lies wholly inside the visible part of the tab strip. Two
 * pixels of slack: the strip measures tabs in whole pixels, and Firefox lays
 * them out in fractions of one.
 */
const tabInView = (page: Page, name: string) =>
  page.getByRole("tablist", { name: "Open files" }).evaluate((list, name) => {
    const tab = [...list.querySelectorAll<HTMLElement>("[data-tab-value]")].find((node) => node.dataset.tabValue === name)
    if (!tab) return false
    const outer = list.getBoundingClientRect()
    const box = tab.getBoundingClientRect()
    return box.left >= outer.left - 2 && box.right <= outer.right + 2
  }, name)

test("twelve open tabs at 1280: +N lists the rest, and the active or focused tab stays in view", async ({ page }) => {
  // Twelve notes load, twice.
  test.slow()
  await page.setViewportSize({ width: 1280, height: 800 })
  const names = Array.from({ length: 12 }, (_, i) => `note-${String(i + 1).padStart(2, "0")}.md`)
  await openProject(page, Object.fromEntries(names.map((name) => [name, `# ${name}\n`])), names[0])
  await remembered(page, names[0])
  await page.evaluate((names) => {
    const key = Object.keys(localStorage).find((key) => key.endsWith("elaborating.tabs.v1"))!
    localStorage.setItem(key, JSON.stringify({ version: 1, openPaths: names, activePath: names[0] }))
  }, names)
  await page.reload()
  // Every tab is still a tab, whether it fits or not.
  for (const name of names) await expect(page.getByRole("tab", { name })).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByRole("tab", { name: names[0] })).toHaveAttribute("aria-selected", "true")
  expect(await tabInView(page, names[0])).toBe(true)
  expect(await tabInView(page, names[11])).toBe(false)

  // "+N" lists exactly the tabs out of view, with the last one among them.
  const more = page.getByRole("button", { name: /^\d+ more open files?$/ })
  await expect(more).toBeVisible()
  const outOfView = async () => {
    const hidden: string[] = []
    for (const name of names) if (!(await tabInView(page, name))) hidden.push(name)
    return hidden.length
  }
  await expect.poll(async () => Number((await more.getAttribute("aria-label"))!.split(" ")[0]) === (await outOfView())).toBe(true)
  const count = await outOfView()
  await more.click()
  await expect(page.getByRole("menuitem")).toHaveCount(count)
  await page.getByRole("menuitem", { name: names[11] }).click()
  await expect(page.getByRole("tab", { name: names[11] })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => tabInView(page, names[11])).toBe(true)
  await expect.poll(() => tabInView(page, names[0])).toBe(false)

  // ArrowRight from the last tab in view focuses the next one and brings it into view.
  await page.getByRole("tab", { name: names[0] }).focus()
  await expect.poll(() => tabInView(page, names[0])).toBe(true)
  let last = 0
  while (await tabInView(page, names[last + 1])) last++
  await page.getByRole("tab", { name: names[last] }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("tab", { name: names[last + 1] })).toBeFocused()
  await expect.poll(() => tabInView(page, names[last + 1])).toBe(true)

  // Alt+Shift+ArrowRight moves the focused tab past one out of view, and it stays in view.
  await page.keyboard.press("Alt+Shift+ArrowRight")
  await expect.poll(() => page.locator("[data-tab-value]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-tab-value"))))
    .toEqual([...names.slice(0, last + 1), names[last + 2], names[last + 1], ...names.slice(last + 3)])
  await expect.poll(() => tabInView(page, names[last + 1])).toBe(true)

  const axe = await new AxeBuilder({ page }).include('[data-slot="editor-header"]').analyze()
  expect(axe.violations).toEqual([])
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("files open from the files screen, and nothing scrolls sideways", async ({ page }) => {
    await openProject(page, { "notes/a.md": "# First\n", "notes/b.md": "# On a phone\n" }, undefined, true)
    await page.getByRole("button", { name: "Back to files and projects" }).click()
    const screen = page.getByRole("region", { name: "Files and projects" })
    await expect(screen).toBeVisible()
    await expect(screen.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
    const expand = screen.getByRole("button", { name: "notes", exact: true, expanded: false })
    if (await expand.count()) await expand.click()
    await screen.getByRole("navigation", { name: "Workspace files" }).getByRole("button", { name: "notes/b.md", exact: true }).click()
    await expect(screen).toBeHidden()
    // A note opens rendered on a phone.
    await expect(page.getByRole("tabpanel", { name: "notes/b.md" }).frameLocator('iframe[title="Isolated document preview"]').getByRole("heading", { name: "On a phone" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })

  test("Save shows only with unsaved edits and saves, and Back keeps the file open", async ({ page }) => {
    const { fake, id } = await openProject(page, { "a.md": "# Title\n" }, "a.md", true)
    const save = page.getByRole("button", { name: "Save, unsaved changes", exact: true })
    await expect(save).toHaveCount(0)
    // A note opens rendered on a phone; type in its source.
    await showView(page, "Source")
    await typeAtEnd(page, "Typed on a phone.")
    await save.click()
    await expect.poll(() => serverContent(fake, id, "a.md")).toBe("# Title\nTyped on a phone.")
    await expect(save).toHaveCount(0)

    // The views are a choice at the top of "...", beside Save.
    await showView(page, "Rendered")
    await page.getByRole("button", { name: "File actions" }).click()
    await expect(page.getByRole("menuitemradio", { name: "Rendered" })).toHaveAttribute("aria-checked", "true")
    await page.keyboard.press("Escape")
    await showView(page, "Source")
    await expect(editorText(page)).toContainText("Typed on a phone.")

    await page.getByRole("button", { name: "Back to files and projects" }).click()
    const screen = page.getByRole("region", { name: "Files and projects" })
    // The open file is marked in the tree.
    const open = screen.getByRole("navigation", { name: "Workspace files" }).getByRole("button", { name: "a.md", exact: true })
    await expect(open).toHaveAttribute("aria-current", "true")
    // Axe finds nothing on the files screen, in light and in dark (Look and theme opens Settings).
    for (const next of ["Dark", "Light"]) {
      // Colours fade to the new theme: axe reads them once the fades are done.
      await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished)))
      const results = await new AxeBuilder({ page }).include("[data-files-screen]").analyze()
      expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
      await screen.getByRole("button", { name: "Look and theme" }).click()
      const settings = page.getByRole("dialog", { name: "Settings" })
      await settings.getByRole("button", { name: next, exact: true }).click()
      await page.keyboard.press("Escape")
      await expect(settings).toBeHidden()
    }
    await open.click()
    await expect(screen).toBeHidden()
    await expect(editorText(page)).toContainText("Typed on a phone.")
  })
})

test("a link in a rendered note opens the file it names in a tab, says when there is none, and opens a web page in a new tab", async ({ page }) => {
  await page.context().route("https://example.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Example</title>" }))
  await openProject(
    page,
    {
      "README.mdx": "# Start here\n\n- [The marble](brainstorm/marble.mdx)\n- [Missing](brainstorm/missing.mdx)\n- [Example](https://example.com/docs)\n",
      "brainstorm/marble.mdx": "# The marble\n",
    },
    "README.mdx",
  )
  await page.getByRole("button", { name: "Rendered" }).click()
  const frame = page.getByRole("tabpanel", { name: "README.mdx" }).frameLocator('iframe[title="Isolated document preview"]')

  await frame.getByRole("link", { name: "The marble" }).click()
  await expect(page.getByRole("tab", { name: "brainstorm/marble.mdx" })).toHaveAttribute("aria-selected", "true")

  await page.getByRole("tab", { name: "README.mdx" }).click()
  await frame.getByRole("link", { name: "Missing" }).click()
  await expect(page.getByText("There's no brainstorm/missing.mdx in this project.")).toBeVisible()
  await expect(page.getByRole("tab", { name: "README.mdx" })).toHaveAttribute("aria-selected", "true")

  const popup = page.waitForEvent("popup")
  await frame.getByRole("link", { name: "Example" }).click()
  expect((await popup).url()).toBe("https://example.com/docs")
  // The note stays where it was: the frame never navigated.
  await expect(frame.getByRole("heading", { name: "Start here" })).toBeVisible()
})

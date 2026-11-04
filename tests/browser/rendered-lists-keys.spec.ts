import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import {
  accepted,
  clickAt,
  expectNoErrors,
  frameOf,
  load,
  openHarness,
  paragraph,
  press,
  releaseTransactions,
  revision,
  selection,
  settled,
  source,
} from "./rendered-support.ts"
import { APP_URL } from "./urls.ts"

// The keys people use on lists and lines in the rendered note, as Notion and
// Google Docs have them: Tab and Shift+Tab move items in and out and never
// take the keyboard out of the text, Delete and Backspace join text, Shift+
// Enter makes a line break, Mod-Enter ticks a task, and fast typing is sent
// in bursts. Every edit must write exactly what the note shows.
// The caret is placed with clicks and arrow keys: on macOS Home and End
// scroll the frame instead of moving the caret.
test.use({ serviceWorkers: "allow", viewport: { width: 1280, height: 900 } })

const NOT_APPLIED = /^Edit not applied:/

// The words in each note are distinct: clickAt finds the first paragraph
// that holds the text it is given.

/** The caret at the end of a paragraph's text. */
async function atEnd(page: Page, text: string) {
  await clickAt(page, text, text.length - 1)
  await press(page, "ArrowRight")
  expect((await selection(page)).focus).toEqual({ paragraph: text, offset: text.length })
}

const inText = (page: Page) =>
  frameOf(page)
    .locator("body")
    .evaluate(() => document.hasFocus() && Boolean(document.activeElement?.closest(".ProseMirror")))
const sent = (page: Page) => page.evaluate(() => window.frameMessages.filter((message) => message.kind === "fluid-transaction").length)
const lineBreaks = (page: Page) => frameOf(page).locator(".ProseMirror br:not(.ProseMirror-trailingBreak)")

test.describe("in the harness", () => {
  let errors: string[] = []
  test.beforeEach(async ({ page }) => {
    errors = await openHarness(page)
  })
  test.afterEach(() => expectNoErrors(errors))

  test("Tab and Shift+Tab keep the keyboard in the text where no item can move, and still move items", async ({ page }) => {
    let mark = await load(page, "# Heading\n\nOpening line\n\n- apple\n- banana\n- cherry\n", "md", /^Opening line$/)
    // The first item cannot go in a level: nothing happens, and typing goes on.
    await atEnd(page, "apple")
    await press(page, "Tab")
    expect(await inText(page)).toBe(true)
    await page.keyboard.type("x")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("# Heading\n\nOpening line\n\n- applex\n- banana\n- cherry\n")
    // Nor can a paragraph or a heading move, either way.
    mark = await revision(page)
    await atEnd(page, "Opening line")
    await press(page, "Shift+Tab")
    await press(page, "Tab")
    await page.keyboard.type("y")
    await accepted(page, mark)
    await frameOf(page).getByRole("heading", { name: "Heading" }).click()
    await press(page, "Tab")
    expect(await inText(page)).toBe(true)
    // A later item goes in, and back out.
    mark = await revision(page)
    await atEnd(page, "banana")
    await press(page, "Tab")
    await accepted(page, mark)
    await expect(frameOf(page).locator("li li")).toHaveText("banana")
    mark = await revision(page)
    await press(page, "Shift+Tab")
    await accepted(page, mark)
    await expect(frameOf(page).locator("li li")).toHaveCount(0)
    await expect.poll(() => source(page)).toBe("# Heading\n\nOpening liney\n\n- applex\n- banana\n- cherry\n")
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("Escape, then Tab, takes the keyboard out of the text to the note's next control", async ({ page }) => {
    const note = "Opening line\n\n- apple\n- banana\n"
    await load(page, note, "md", /^Opening line$/)
    await atEnd(page, "Opening line")
    await press(page, "Escape")
    await press(page, "Tab")
    await expect(frameOf(page).getByRole("button", { name: "Insert block" })).toBeFocused()
    // Shift+Tab from there comes back to the text.
    await press(page, "Shift+Tab")
    expect(await inText(page)).toBe(true)
    // A key between Escape and Tab keeps Tab in the text.
    await press(page, "Escape")
    await press(page, "ArrowLeft")
    await press(page, "Tab")
    expect(await inText(page)).toBe(true)
    expect(await source(page)).toBe(note)
  })

  test("Delete at the end of an item joins the next item's text, also from an empty item", async ({ page }) => {
    let mark = await load(page, "- alpha\n- bravo\n- charlie\n\n1. first\n2. second\n", "md", /^alpha$/)
    await atEnd(page, "alpha")
    await press(page, "Delete")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- alphabravo\n- charlie\n\n1. first\n2. second\n")
    expect((await selection(page)).focus).toEqual({ paragraph: "alphabravo", offset: 5 })
    mark = await revision(page)
    await atEnd(page, "first")
    await press(page, "Delete")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- alphabravo\n- charlie\n\n1. firstsecond\n")
    // An empty item takes the text of the item after it.
    mark = await load(page, "- alpha\n-\n- charlie\n", "md", /^alpha$/)
    await atEnd(page, "alpha")
    await press(page, "ArrowDown")
    await press(page, "Delete")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- alpha\n- charlie\n")
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("Backspace at the start of a nested list's first item moves it out a level", async ({ page }) => {
    for (const format of ["md", "mdx"] as const) {
      let mark = await load(page, "- parent\n  - child\n  - sibling\n- after\n", format, /^parent$/)
      await clickAt(page, "child", 0)
      expect((await selection(page)).focus).toEqual({ paragraph: "child", offset: 0 })
      await press(page, "Backspace")
      await accepted(page, mark)
      // The sibling stays under it, as Shift+Tab leaves it.
      await expect(frameOf(page).locator(".ProseMirror > ul > li")).toHaveCount(3)
      await expect(frameOf(page).locator("li li")).toHaveText("sibling")
      expect((await selection(page)).focus).toEqual({ paragraph: "child", offset: 0 })
      mark = await revision(page)
      await page.keyboard.type("x")
      await accepted(page, mark)
      await expect(paragraph(page, /^xchild$/)).toBeVisible()
      expect(await source(page)).toMatch(/^- parent\n- xchild\n {2,4}- sibling\n- after\n$/)
    }
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("Backspace at the start of a numbered nested list's first item moves it out a level, and the numbers count on", async ({ page }) => {
    const mark = await load(page, "1. parent\n   1. child\n   2. sibling\n2. after\n", "md", /^parent$/)
    await clickAt(page, "child", 0)
    await press(page, "Backspace")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("1. parent\n2. child\n   1. sibling\n3. after\n")
    await expect(frameOf(page).locator("li li")).toHaveText("sibling")
    expect((await selection(page)).focus).toEqual({ paragraph: "child", offset: 0 })
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("Shift+Tab on an item with a nested list and items after it makes one list of them", async ({ page }) => {
    for (const [note, word, expected] of [
      ["- alpha\n  - beta\n- gamma\n", "alpha", "alpha\n\n- beta\n- gamma\n"],
      ["- zero\n- alpha\n  - beta\n- gamma\n", "alpha", "- zero\n\nalpha\n\n- beta\n- gamma\n"],
      ["1. alpha\n   1. beta\n2. gamma\n", "alpha", "alpha\n\n1. beta\n2. gamma\n"],
      ["- top\n  - mid\n    - low\n  - next\n- last\n", "mid", "- top\n- mid\n  - low\n  - next\n- last\n"],
    ]) {
      const mark = await load(page, note, "md", new RegExp(`^${word}$`))
      await atEnd(page, word)
      await press(page, "Shift+Tab")
      await accepted(page, mark)
      await expect.poll(() => source(page)).toBe(expected)
      expect((await selection(page)).focus).toEqual({ paragraph: word, offset: word.length })
      await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
    }
  })

  test("Tab from a control inside the note, such as a table's scroll region, moves on as the browser would", async ({ page }) => {
    const note = "Opening line\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
    await load(page, note, "md", /^Opening line$/)
    const table = frameOf(page).getByRole("region", { name: "Document table" })
    await table.focus()
    await expect(table).toBeFocused()
    await press(page, "Tab")
    await expect(table).not.toBeFocused()
    await table.focus()
    await press(page, "Shift+Tab")
    await expect(table).not.toBeFocused()
    expect(await source(page)).toBe(note)
  })

  test("a click between Escape and Tab puts Tab back to moving items", async ({ page }) => {
    const mark = await load(page, "Opening line\n\n- apple\n- banana\n", "md", /^Opening line$/)
    await atEnd(page, "Opening line")
    await press(page, "Escape")
    await clickAt(page, "banana", 3)
    await press(page, "Tab")
    expect(await inText(page)).toBe(true)
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("Opening line\n\n- apple\n  - banana\n")
  })

  test("Shift+Enter makes a line break, at the end of a line once text follows it", async ({ page }) => {
    // In the middle of a line, at once; the break takes the space after it.
    let mark = await load(page, "alpha bravo\n\n- item one\n- item two\n", "md", /^alpha bravo$/)
    await clickAt(page, "alpha bravo", 5)
    await press(page, "Shift+Enter")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alpha\\\nbravo\n\n- item one\n- item two\n")
    await expect(lineBreaks(page)).toHaveCount(1)
    // At the end of an item it shows at once, and is sent with what is typed after it.
    mark = await revision(page)
    await atEnd(page, "item one")
    const before = await sent(page)
    await press(page, "Shift+Enter")
    await expect(lineBreaks(page)).toHaveCount(2)
    expect(await sent(page)).toBe(before)
    await page.keyboard.type("next line")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alpha\\\nbravo\n\n- item one\\\nnext line\n- item two\n")
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("a line break at the end of a line goes again when the caret leaves it, with nothing sent", async ({ page }) => {
    const note = "- first\n- second\n\n# Title\n"
    await load(page, note, "md", /^first$/)
    const before = await sent(page)
    // Leaving the line takes it out.
    await atEnd(page, "first")
    await press(page, "Shift+Enter")
    await expect(lineBreaks(page)).toHaveCount(1)
    await press(page, "ArrowDown")
    await expect(lineBreaks(page)).toHaveCount(0)
    // Backspace takes it out, and the caret is at the end of the line again.
    await atEnd(page, "first")
    await press(page, "Shift+Enter")
    await expect(lineBreaks(page)).toHaveCount(1)
    await press(page, "Backspace")
    await expect(lineBreaks(page)).toHaveCount(0)
    expect((await selection(page)).focus).toEqual({ paragraph: "first", offset: 5 })
    // Undo takes it out too, and does nothing else.
    await press(page, "Shift+Enter")
    await press(page, "ControlOrMeta+z")
    await expect(lineBreaks(page)).toHaveCount(0)
    // Spaces cannot start a line in Markdown: typed after the break, they are not kept.
    await press(page, "Shift+Enter")
    await page.keyboard.type(" ")
    await expect(lineBreaks(page)).toHaveCount(1)
    await press(page, "ArrowUp")
    await expect(lineBreaks(page)).toHaveCount(0)
    // A heading has no line breaks: there the key does nothing.
    await frameOf(page).getByRole("heading", { name: "Title" }).click()
    await press(page, "Shift+Enter")
    await expect(lineBreaks(page)).toHaveCount(0)
    expect(await sent(page)).toBe(before)
    expect(await source(page)).toBe(note)
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("Backspace over the text after a line break keeps the break and writes the rest", async ({ page }) => {
    let mark = await load(page, "- item one\n- item two\n", "md", /^item one$/)
    await atEnd(page, "item one")
    await press(page, "Shift+Enter")
    await page.keyboard.type("x")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- item one\\\nx\n- item two\n")
    // The letter goes; the break stays on screen, and the note has neither.
    mark = await revision(page)
    await press(page, "Backspace")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- item one\n- item two\n")
    await expect(lineBreaks(page)).toHaveCount(1)
    // Text typed there goes with the break again.
    mark = await revision(page)
    await page.keyboard.type("yz")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- item one\\\nyz\n- item two\n")
    // Both letters out at once, then the caret leaves: the break goes too.
    mark = await revision(page)
    await press(page, "Shift+ArrowLeft", 2)
    await press(page, "Backspace")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- item one\n- item two\n")
    await press(page, "ArrowDown")
    await expect(lineBreaks(page)).toHaveCount(0)
    expect(await source(page)).toBe("- item one\n- item two\n")
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("after Shift+Enter, what is typed goes on the new line, also where the break takes a space or a selected word", async ({ page }) => {
    let mark = await load(page, "alpha bravo\n\nkeep this line\n", "md", /^alpha bravo$/)
    await clickAt(page, "alpha bravo", 5)
    await press(page, "Shift+Enter")
    await page.keyboard.type("x")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alpha\\\nxbravo\n\nkeep this line\n")
    mark = await revision(page)
    await clickAt(page, "keep this line", 5)
    await press(page, "Shift+ArrowRight", 4)
    await press(page, "Shift+Enter")
    await page.keyboard.type("y")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alpha\\\nxbravo\n\nkeep \\\nyline\n")
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("Shift+Enter at the end of a line the note breaks makes a new line there, and typing goes on it", async ({ page }) => {
    // A line break typed in Source, which Markdown reads as part of the paragraph.
    const mark = await load(page, "Dear team,\nthanks for the notes.\n", "md", /^Dear team,/)
    await clickAt(page, "Dear team,", 9)
    await press(page, "ArrowRight")
    await press(page, "Shift+Enter")
    await page.keyboard.type("x")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("Dear team,\\\nx\\\nthanks for the notes.\n")
    await expect(lineBreaks(page)).toHaveCount(2)
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("a line break typed over a word at the end of a line takes the word out, and it stays out when the caret leaves", async ({ page }) => {
    const mark = await load(page, "alpha bravo\n\nNext line.\n", "md", /^alpha bravo$/)
    await clickAt(page, "alpha bravo", 6)
    await press(page, "Shift+ArrowRight", 5)
    await press(page, "Shift+Enter")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alpha \n\nNext line.\n")
    await expect(lineBreaks(page)).toHaveCount(1)
    await clickAt(page, "Next line.", 2)
    await expect(lineBreaks(page)).toHaveCount(0)
    await expect(paragraph(page, /^alpha $/)).toBeVisible()
    expect(await source(page)).toBe("alpha \n\nNext line.\n")
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("ArrowLeft or ArrowUp from a held line break puts the caret at the end of its line, and Delete brings the next item's text up after it", async ({ page }) => {
    await load(page, "alpha\n\n- one\n- two\n", "md", /^alpha$/)
    for (const key of ["ArrowLeft", "ArrowUp"]) {
      await atEnd(page, "alpha")
      await press(page, "Shift+Enter")
      await expect(lineBreaks(page)).toHaveCount(1)
      await press(page, key)
      await expect(lineBreaks(page)).toHaveCount(0)
      expect((await selection(page)).focus, key).toEqual({ paragraph: "alpha", offset: 5 })
    }
    const mark = await revision(page)
    await atEnd(page, "one")
    await press(page, "Shift+Enter")
    await press(page, "Delete")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alpha\n\n- one\\\ntwo\n")
    await expect(lineBreaks(page)).toHaveCount(1)
    await expect(page.getByText(NOT_APPLIED)).toHaveCount(0)
  })

  test("Enter at the start of the line after a line break makes that line a paragraph, with no empty line left above it", async ({ page }) => {
    let mark = await load(page, "alpha\\\nbravo\n", "md", /^alphabravo$/)
    await clickAt(page, "alphabravo", 5)
    await press(page, "Enter")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alpha\n\nbravo\n")
    await expect(lineBreaks(page)).toHaveCount(0)
    expect((await selection(page)).focus).toEqual({ paragraph: "bravo", offset: 0 })
    // Backspace then joins the two paragraphs, as it would any two.
    mark = await revision(page)
    await press(page, "Backspace")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("alphabravo\n")
  })

  test("Enter after a line break at the end of an item makes a new item, as Enter alone does", async ({ page }) => {
    const mark = await load(page, "- first\n- second\n", "md", /^first$/)
    await atEnd(page, "first")
    await press(page, "Shift+Enter")
    await press(page, "Enter")
    await page.keyboard.type("new")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("- first\n- new\n- second\n")
    await expect(lineBreaks(page)).toHaveCount(0)
  })

  test("Mod-Enter in a task item ticks and unticks its box", async ({ page }) => {
    let mark = await load(page, "- [ ] Pack the charger\n- [x] Book the train\n", "md", /^Pack the charger$/)
    const pack = frameOf(page).getByRole("checkbox", { name: "Pack the charger" })
    await atEnd(page, "Pack the charger")
    await press(page, "ControlOrMeta+Enter")
    await accepted(page, mark)
    await expect(pack).toBeChecked()
    await expect.poll(() => source(page)).toBe("- [x] Pack the charger\n- [x] Book the train\n")
    mark = await revision(page)
    await press(page, "ControlOrMeta+Enter")
    await accepted(page, mark)
    await expect(pack).not.toBeChecked()
    await expect.poll(() => source(page)).toBe("- [ ] Pack the charger\n- [x] Book the train\n")
    // The keyboard stays in the text.
    expect(await inText(page)).toBe(true)
    expect((await selection(page)).focus).toEqual({ paragraph: "Pack the charger", offset: 16 })
  })

  test("typing while an edit is being checked is sent as one edit, every character in order", async ({ page }) => {
    const mark = await load(page, "Start of a paragraph.\n\n- item\n", "md", /^Start of a paragraph\.$/)
    await atEnd(page, "Start of a paragraph.")
    const before = await sent(page)
    await page.evaluate(() => {
      window.transactionGate.enabled = true
    })
    await page.keyboard.type(" Then twenty more keys")
    await page.waitForFunction(() => window.transactionGate.held.length > 0)
    expect(await releaseTransactions(page)).toBe(1)
    await accepted(page, mark)
    await settled(page)
    await expect.poll(() => source(page)).toBe("Start of a paragraph. Then twenty more keys\n\n- item\n")
    // The first key went at once; the rest waited, as one edit.
    expect((await sent(page)) - before).toBe(2)
  })
})

test.describe("in the app", () => {
  test.describe.configure({ timeout: 60_000 })
  const NOTE = "# Steps\n\n- alpha\n- bravo\n- charlie\n\nTail paragraph.\n"

  async function openNote(page: Page) {
    const fake = await fakeSupabase(page)
    const remote = fake.server.remote(person.id)
    const id = crypto.randomUUID()
    await remote.createProject(id, "Notes")
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/lists.md", content: NOTE }])
    await signedIn(page)
    await page.goto(new URL(`projects/${id}/notes/lists.md`, APP_URL).href)
    await page.getByRole("button", { name: "Rendered" }).click()
    await expect(paragraph(page, /^bravo$/)).toBeVisible({ timeout: 15_000 })
  }
  const items = (page: Page) => frameOf(page).locator(".ProseMirror li")
  const nested = (page: Page) => frameOf(page).locator(".ProseMirror li li")

  test("Ctrl+Z after Tab in a list puts the caret back in the item, and Ctrl+Shift+Z keeps it there", async ({ page }) => {
    await openNote(page)
    // The note opened in Source first: undo goes through the code editor's history.
    await expect(page.locator(".monaco-editor")).toHaveCount(1)
    await atEnd(page, "bravo")
    await press(page, "Tab")
    await expect(nested(page)).toHaveCount(1)
    await press(page, "ControlOrMeta+z")
    await expect(nested(page)).toHaveCount(0)
    await expect.poll(async () => (await selection(page)).focus).toEqual({ paragraph: "bravo", offset: 5 })
    await press(page, "ControlOrMeta+Shift+z")
    await expect(nested(page)).toHaveCount(1)
    await expect.poll(async () => (await selection(page)).focus).toEqual({ paragraph: "bravo", offset: 5 })
    await page.keyboard.type("Q")
    await expect(paragraph(page, /^bravoQ$/)).toBeVisible()
  })

  test("Ctrl+Z after Enter and typing in a list takes the text back first, then the new item", async ({ page }) => {
    await openNote(page)
    await atEnd(page, "bravo")
    await press(page, "Enter")
    await page.keyboard.type("new")
    await expect(paragraph(page, /^new$/)).toBeVisible()
    await press(page, "ControlOrMeta+z")
    await expect(paragraph(page, /^new$/)).toHaveCount(0)
    await expect(items(page)).toHaveCount(4)
    await expect.poll(async () => (await selection(page)).focus).toEqual({ paragraph: "", offset: 0 })
    await press(page, "ControlOrMeta+z")
    await expect(items(page)).toHaveCount(3)
    await expect.poll(async () => (await selection(page)).focus).toEqual({ paragraph: "bravo", offset: 5 })
    await press(page, "ControlOrMeta+Shift+z")
    await expect(items(page)).toHaveCount(4)
    await press(page, "ControlOrMeta+Shift+z")
    await expect(paragraph(page, /^new$/)).toBeVisible()
    await expect.poll(async () => (await selection(page)).focus).toEqual({ paragraph: "new", offset: 3 })
    await page.keyboard.type("Q")
    await expect(paragraph(page, /^newQ$/)).toBeVisible()
  })
})

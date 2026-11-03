import { expect, test, type Page } from "./fixtures.ts"
import { accepted, clickAt, expectNoErrors, frameOf, load, openHarness, press, revision, source } from "./rendered-support.ts"

// List edits in the rendered view that Markdown writes in a form of its own:
// a new item that holds the nested list after it, a nested list whose first
// item is still empty, an ordered list that counts on, a list split by an
// empty line, and text typed beside an image or a component. Each is written
// into the note exactly, with no "Edit not applied" notice. Every edit is real
// mouse and keyboard input; the caret reaches a line's end by clicking its last
// character and pressing the right arrow (Home and End scroll on macOS).

// Playwright's service worker blocking runs a script in every frame, which
// throws inside the sandboxed preview frame (as in rendered-editing.spec.ts).
test.use({ serviceWorkers: "allow" })
test.use({ viewport: { width: 1280, height: 900 } })

const NOTICE = /^Edit not applied:/
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#36c"/></svg>'

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = await openHarness(page)
})
test.afterEach(() => expectNoErrors(errors))

/** The caret at the end of the paragraph whose text is `text`. */
async function atEnd(page: Page, text: string) {
  await clickAt(page, text, text.length - 1)
  await press(page, "ArrowRight")
}

/** Press `key` and wait until the note took it. */
async function key(page: Page, name: string) {
  const mark = await revision(page)
  await press(page, name)
  await accepted(page, mark)
}

/** Type `text` and wait until the note shows `expected`. */
async function typed(page: Page, text: string, expected: string) {
  await page.keyboard.type(text)
  await expect.poll(() => source(page)).toBe(expected)
  await expect(page.getByText(NOTICE)).toHaveCount(0)
}

for (const format of ["md", "mdx"] as const) {
  test(`${format}: Enter at the end of an item with a nested list starts an item that holds it, and typing goes there`, async ({ page }) => {
    await load(page, "- alpha\n  - beta\n- gamma", format, /^alpha$/)
    await atEnd(page, "alpha")
    await key(page, "Enter")
    expect(await source(page)).toBe("- alpha\n- \n  - beta\n- gamma")
    await expect(frameOf(page).locator("li li")).toHaveText("beta")
    await typed(page, "new", "- alpha\n- new\n  - beta\n- gamma")
    await expect(frameOf(page).locator("li")).toHaveCount(4)
  })

  test(`${format}: Enter, Tab and typing make a nested item, in a bullet list and a numbered one`, async ({ page }) => {
    for (const [list, last, nested] of [
      ["- a\n- b", "b", "- a\n- b\n  - nested"],
      ["1. a\n2. b", "b", "1. a\n2. b\n   1. nested"],
    ] as const) {
      await load(page, list, format, new RegExp(`^${last}$`))
      await atEnd(page, last)
      await key(page, "Enter")
      await key(page, "Tab")
      await expect(frameOf(page).locator("li li")).toHaveCount(1)
      await typed(page, "nested", nested)
      await expect(frameOf(page).locator("li li")).toHaveText("nested")
    }
  })

  test(`${format}: Tab and Shift+Tab in a numbered list move the item and keep the numbers counting`, async ({ page }) => {
    await load(page, "1. a\n2. b\n3. c", format, /^b$/)
    await clickAt(page, "b", 0)
    await key(page, "Tab")
    expect(await source(page)).toBe("1. a\n   1. b\n2. c")
    await expect(frameOf(page).locator("li li")).toHaveText("b")
    await key(page, "Shift+Tab")
    expect(await source(page)).toBe("1. a\n2. b\n3. c")
    await expect(frameOf(page).locator("li li")).toHaveCount(0)
    await expect(page.getByText(NOTICE)).toHaveCount(0)
  })

  test(`${format}: Enter on an empty item between two others splits the list around an empty line`, async ({ page }) => {
    await load(page, "- a\n- \n- c", format, /^c$/)
    await frameOf(page).locator("li > p").nth(1).click()
    await key(page, "Enter")
    expect(await source(page)).toBe("- a\n\n\n\n* c")
    await expect(frameOf(page).locator(".ProseMirror > ul")).toHaveCount(2)
    await typed(page, "between", "- a\n\nbetween\n\n* c")
  })

  test(`${format}: text typed after an image at the end of a line is kept`, async ({ page }) => {
    await page.evaluate((svg) => window.renderedHarness.setResources({ "a.svg": svg }), SVG)
    await load(page, "Hello ![x](a.svg)\n\nAfter.", format, /^After\.$/)
    // Past the image's right edge, on its line: the caret goes after it.
    const image = frameOf(page).locator(".ProseMirror > p [data-fluid-object]").first()
    const box = (await image.boundingBox())!
    await page.mouse.click(box.x + box.width + 40, box.y + box.height / 2)
    await typed(page, "z", "Hello ![x](a.svg)z\n\nAfter.")
  })

  test(`${format}: Tab on an item after a code block in a list nests it, and the code block stays as written`, async ({ page }) => {
    const fenced = "- a\n  ```js\n  x()\n  ```\n- b"
    await load(page, fenced, format, /^b$/)
    await clickAt(page, "b", 0)
    await key(page, "Tab")
    expect(await source(page)).toBe("- a\n  ```js\n  x()\n  ```\n  - b")
    await expect(frameOf(page).locator("li li")).toHaveText("b")
    await expect(page.getByText(NOTICE)).toHaveCount(0)
  })

  test(`${format}: a list with a code block on an item's first line stays editable around it`, async ({ page }) => {
    await load(page, "Intro.\n\n- ```js\n  code()\n  ```\n- b\n- c", format, /^b$/)
    await atEnd(page, "b")
    await typed(page, "x", "Intro.\n\n- ```js\n  code()\n  ```\n- bx\n- c")
    await key(page, "Enter")
    await typed(page, "new", "Intro.\n\n- ```js\n  code()\n  ```\n- bx\n- new\n- c")
  })
}

test("text typed after a component at the end of a line is kept", async ({ page }) => {
  await load(page, "Hello <Counter />\n\nAfter.", "mdx", /^After\.$/)
  const island = frameOf(page).locator(".ProseMirror > p [data-fluid-object]").first()
  const box = (await island.boundingBox())!
  await page.mouse.click(box.x + box.width + 40, box.y + box.height / 2)
  await typed(page, "z", "Hello <Counter />z\n\nAfter.")
})

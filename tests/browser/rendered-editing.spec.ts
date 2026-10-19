import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "./fixtures.ts"
import {
  accepted,
  clickAt,
  expectNoErrors,
  frameOf,
  load,
  openHarness,
  paragraph,
  point,
  press,
  releaseTransactions,
  revision,
  selection,
  settled,
  source,
  type Revision,
} from "./rendered-support.ts"

// Editing a note in the rendered view with real mouse and keyboard input.
// Every edit must change exactly the source it shows and nothing else, and
// edits that would break MDX the view cannot represent are refused.
// (Undo through the source editor is checked once the source editor is
// mounted, roadmap phase 2 step 10.)

// Playwright's service worker blocking (playwright.config.ts) runs a script in
// every frame, which throws inside the sandboxed preview frame. The harness
// registers no worker, so these tests leave workers allowed.
test.use({ serviceWorkers: "allow" })

const prefix = "export const untouched = 7;\n\n{/* preserve  this comment */}\n\n"
const first = "Start **bold** and *emphasis* plus `code` and [link](https://example.com) end."
const plain = "Start bold and emphasis plus code and link end."
const second = "Second paragraph tail."
const suffix = "\n\n- First list item\n- Second list item\n\n<Counter initial={untouched} />\n\nUntouched tail.\n"
const original = `${prefix}${first}\n\n${second}${suffix}`

test.use({ viewport: { width: 1280, height: 900 } })

// What "Edit not applied:" says for an edit to computed or unshown source, and for one Markdown cannot hold.
const PROTECTED = "This part of the note comes from code or isn't shown here, so it can't be changed in Rendered. Change it in Source."
const UNWRITABLE = "This change can't be written into the note's Markdown exactly as it looks here, so it was undone. Make it in Source."

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = await openHarness(page)
})
test.afterEach(() => expectNoErrors(errors))

const fresh = (page: Page, content = original) => load(page, content, "mdx", plain)

/** Leave the editor so the edit commits, then check the exact source. */
async function commit(page: Page, mark: Revision, expected: string) {
  await page.keyboard.press("Tab")
  await accepted(page, mark)
  // Later keystrokes may still be on their way; wait for all of them.
  await expect.poll(() => source(page)).toBe(expected)
}

test.describe("prose", () => {
  test("arrow keys cross bold, emphasis, code and link boundaries", async ({ page }) => {
    await fresh(page)
    /**
     * Press an arrow key `count` times and return the caret's offset. Firefox
     * spends one keypress crossing inline code's decorative backticks without
     * moving in the text, so code allows one extra press.
     */
    const arrow = async (key: string, count: number, target: number, extra: number) => {
      await press(page, key, count)
      let offset = (await selection(page)).focus?.offset
      for (let left = extra; offset !== target && left > 0; left--) {
        await press(page, key)
        offset = (await selection(page)).focus?.offset
      }
      return offset
    }
    for (const word of ["bold", "emphasis", "code", "link"]) {
      const at = plain.indexOf(word)
      const extra = word === "code" ? 1 : 0
      await clickAt(page, plain, at)
      expect((await selection(page)).focus?.offset, `${word}: click`).toBe(at)
      expect(await arrow("ArrowLeft", 1, at - 1, extra), `${word}: ArrowLeft`).toBe(at - 1)
      await clickAt(page, plain, at + word.length - 1)
      expect(await arrow("ArrowRight", 2, at + word.length + 1, extra), `${word}: ArrowRight`).toBe(at + word.length + 1)
    }
    expect(await source(page)).toBe(original)
  })

  test("arrow keys cross paragraph boundaries", async ({ page }) => {
    await fresh(page)
    await clickAt(page, second, 0)
    await press(page, "Home")
    await press(page, "ArrowLeft")
    expect((await selection(page)).focus?.paragraph).toBe(plain)
    await clickAt(page, plain, plain.length - 1)
    await press(page, "End")
    await press(page, "ArrowRight")
    expect((await selection(page)).focus?.paragraph).toBe(second)
    await clickAt(page, plain, plain.length - 1)
    await press(page, "End")
    await press(page, "ArrowDown")
    expect((await selection(page)).focus?.paragraph).toBe(second)
    await clickAt(page, second, 0)
    await press(page, "Home")
    await press(page, "ArrowUp")
    expect((await selection(page)).focus?.paragraph).toBe(plain)
  })

  test("a keyboard selection across formatting is replaced exactly", async ({ page }) => {
    const mark = await fresh(page)
    await clickAt(page, plain, 0)
    await press(page, "Home")
    await press(page, "ArrowRight", 5)
    await press(page, "Shift+ArrowRight", 6)
    expect((await selection(page)).text).toBe(" bold ")
    await page.keyboard.type("BRIDGE")
    await commit(page, mark, original.replace(" **bold** ", "BRIDGE"))
  })

  test("a mouse selection across paragraphs is replaced exactly", async ({ page }) => {
    const mark = await fresh(page)
    const from = await point(page, plain, plain.indexOf("end."))
    const to = await point(page, second, 6)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    expect((await selection(page)).text?.replace(/\s+/g, " ")).toBe("end. Second")
    await page.keyboard.type("JOIN")
    await commit(page, mark, original.replace("end.\n\nSecond", "JOIN"))
  })

  test("a burst of typing keeps every character", async ({ page }) => {
    const mark = await fresh(page)
    await clickAt(page, second, 0)
    await press(page, "Home")
    await press(page, "ArrowRight", 7)
    await page.keyboard.type("Burst123")
    await commit(page, mark, original.replace(second, "Second Burst123paragraph tail."))
  })

  test("Enter splits a paragraph and Backspace joins two, exactly", async ({ page }) => {
    const before = original.replace(second, "Alphabeta.")
    let mark = await fresh(page, before)
    await clickAt(page, "Alphabeta.", 0)
    await press(page, "Home")
    await press(page, "ArrowRight", 5)
    await press(page, "Enter")
    await accepted(page, mark)
    await paragraph(page, /^beta\.$/).waitFor()
    expect((await selection(page)).focus).toEqual({ paragraph: "beta.", offset: 0 })
    expect(await source(page)).toBe(before.replace("Alphabeta.", "Alpha\n\nbeta."))

    mark = await fresh(page)
    await clickAt(page, second, 0)
    await press(page, "Home")
    await press(page, "Backspace")
    await commit(page, mark, original.replace(`${first}\n\n${second}`, `${first}${second}`))
  })

  test("Enter straight after arrow keys splits at the caret, every time", async ({ page }) => {
    // Chromium can tell the editor about an arrow key's caret move only after
    // the next key, which once made Enter split where the caret had been
    // (task T10). It happened in about one run in four, so repeat.
    test.slow()
    for (let run = 1; run <= 20; run++) {
      const tail = `Untouched tail, run ${run}.`
      const before = original.replace(second, "Alphabeta.").replace("Untouched tail.", tail)
      const mark = await load(page, before, "mdx", tail)
      await clickAt(page, "Alphabeta.", 0)
      await press(page, "Home")
      await press(page, "ArrowRight", 5)
      await press(page, "Enter")
      await accepted(page, mark)
      await expect.poll(() => source(page), { message: `run ${run}` }).toBe(before.replace("Alphabeta.", "Alpha\n\nbeta."))
    }
  })

  test("a selection across a component is refused and the source kept", async ({ page }) => {
    await fresh(page)
    const from = await point(page, second, 0)
    const to = await point(page, "Untouched tail.", 9)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 16 })
    await page.mouse.up()
    const selected = (await selection(page)).text ?? ""
    expect(selected).toContain("Second paragraph tail.")
    expect(selected).toContain("Untouched")
    await press(page, "Delete")
    await expect(page.getByRole("alert").or(page.getByRole("status")).filter({ hasText: /rejected|unsupported|protected|computed output/i }).first()).toBeVisible()
    expect(await source(page)).toBe(original)
  })
})

test.describe("while an edit is in flight", () => {
  test("the page reports it pending and the source waits for it", async ({ page }) => {
    const initial = "Anchor\n\n{/* untouched comment */}\n"
    await load(page, initial, "mdx", /^Anchor$/)
    await page.evaluate(() => {
      window.transactionGate.enabled = true
    })
    await clickAt(page, "Anchor", 0)
    await press(page, "Home")
    await page.keyboard.type("Pending123")
    await page.waitForFunction(() => window.transactionGate.held.length > 0)
    await paragraph(page, /^Pending123Anchor$/).waitFor()
    await expect.poll(() => page.evaluate(() => window.renderedHarness.state().pending)).toBe(true)
    expect(await source(page)).toBe(initial)

    expect(await releaseTransactions(page)).toBeGreaterThan(0)
    await settled(page)
    await expect.poll(() => source(page)).toBe(`Pending123${initial}`)
    expect(await page.evaluate(() => window.renderedHarness.state().pending)).toBe(false)
  })
})

test.describe("MDX documents", () => {
  const fixture =
    '# Document cadence\n\nSource-owned paragraph.\n\n## Installation\n\nUse `bun`.\n\n<Callout tone="warn" title="Before you publish">Keep source.</Callout>\n\n<Columns><Card><CardContent>First</CardContent></Card><Card><CardContent>Second</CardContent></Card></Columns>\n\n~~~sh\nbun run build\n~~~\n\n| Check | Result |\n| --- | --- |\n| Source | kept |\n\n- Compact item\n- Second item\n'

  test("fast typing edits only its paragraph and never resets the editor", async ({ page }) => {
    await load(page, fixture, "mdx", /^Source-owned paragraph\.$/)
    await frameOf(page)
      .locator("body")
      .evaluate(() => {
        const trace = ((window as unknown as { resets: number }).resets = 0)
        void trace
        window.pagePort!.addEventListener("message", (event) => {
          if (event.data?.kind === "render" && event.data.fluid?.reset) (window as unknown as { resets: number }).resets++
        })
      })
    await paragraph(page, /^Source-owned paragraph\.$/).click()
    await press(page, "End")
    await page.keyboard.type(" Updated")
    await settled(page)
    await expect.poll(() => source(page)).toBe(fixture.replace("Source-owned paragraph.", "Source-owned paragraph. Updated"))
    expect(await frameOf(page).locator("body").evaluate(() => (window as unknown as { resets: number }).resets)).toBe(0)
  })

  test("shortcuts next to computed text keep the exact source, and refusals are notices", async ({ page }) => {
    const text = "Before.\n\n#Inline {2 + 2} text.\n\n-Inline {3 + 3} text.\n\nAfter."
    const heading = text.replace("#Inline", "# Inline")
    await load(page, text, "mdx", /^Before\.$/)
    await frameOf(page).locator(".ProseMirror > p").filter({ hasText: /^#Inline 4 text\.$/ }).click()
    await press(page, "Home")
    await press(page, "ArrowRight")
    await page.keyboard.type(" ")
    await frameOf(page).locator(".ProseMirror > h1").filter({ hasText: /^Inline 4 text\.$/ }).waitFor()
    await expect.poll(() => source(page)).toBe(heading)

    await frameOf(page).locator(".ProseMirror > p").filter({ hasText: /^-Inline 6 text\.$/ }).click()
    await press(page, "Home")
    await press(page, "ArrowRight")
    await page.keyboard.type(" ")
    // The notice is the library's banner, a status, and says why in plain words.
    const notice = page.getByRole("status").filter({ hasText: PROTECTED }).first()
    await expect(notice).toBeVisible()
    await expect(notice).toHaveText(/^Edit not applied:/)
    expect(await source(page)).toBe(heading)

    await frameOf(page).locator(".ProseMirror > p").filter({ hasText: /^Before\.$/ }).click()
    await press(page, "ControlOrMeta+a")
    await press(page, "Backspace")
    await expect(page.getByText(/This selection crosses computed output/).first()).toBeVisible()
    expect(await source(page)).toBe(heading)
    await expect(page.locator('iframe[title="Isolated document preview"]')).toBeVisible()

    await frameOf(page).locator(".ProseMirror > p").filter({ hasText: /^After\.$/ }).click()
    await press(page, "End")
    await page.keyboard.type(" More")
    await expect.poll(() => source(page)).toBe(`${heading} More`)
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })

  test("typing straight after a refused select-all edit keeps every character, even when the click is reported late", async ({ page }) => {
    // Chromium can tell the editor about a click's caret only after the next
    // keys (a late selectionchange). The editor still had the whole note
    // selected from the refused edit, so those keys replaced the whole note,
    // which its computed text refuses, and their characters were lost. The
    // reports are held back here so that happens every time.
    const text = "Before.\n\nInline {2 + 2} text.\n\nAfter."
    await load(page, text, "mdx", /^Before\.$/)
    await paragraph(page, /^Before\.$/).click()
    await press(page, "ControlOrMeta+a")
    await press(page, "Backspace")
    await expect(page.getByText(/This selection crosses computed output/).first()).toBeVisible()
    const body = frameOf(page).locator("body")
    await body.evaluate(() => {
      const held = { on: true, any: false }
      window.addEventListener(
        "selectionchange",
        (event) => {
          if (!held.on) return
          held.any = true
          event.stopPropagation()
        },
        true,
      )
      ;(window as unknown as { releaseSelection: () => void }).releaseSelection = () => {
        held.on = false
        if (held.any) document.dispatchEvent(new Event("selectionchange"))
      }
    })
    await paragraph(page, /^After\.$/).click()
    await press(page, "End")
    await page.keyboard.type(" More")
    await body.evaluate(() => (window as unknown as { releaseSelection: () => void }).releaseSelection())
    await expect.poll(() => source(page)).toBe(`${text} More`)
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })
})

test.describe("lists", () => {
  const before = `${prefix}Before paragraph.\n\n`
  const after = "\n\n<Counter initial={untouched} />\n\nAfter paragraph.\n"
  const list = `${before}* first\n* second\n* third${after}`

  for (const command of ["Backspace", "Enter"]) {
    test(`${command} in an empty last item leaves the list and typing continues`, async ({ page }) => {
      let mark = await load(page, list, "mdx", /^Before paragraph\.$/)
      await paragraph(page, /^third$/).click()
      await press(page, "End")
      await press(page, "Shift+Home")
      expect((await selection(page)).text).toBe("third")
      await press(page, "Backspace")
      await accepted(page, mark)
      mark = await revision(page)
      await press(page, command)
      await accepted(page, mark)
      await expect(frameOf(page).locator("li")).toHaveCount(2)
      const caret = await selection(page)
      expect(caret).toMatchObject({ focused: true, collapsed: true })
      expect(caret.focus?.paragraph).toBe("")
      for (const character of "Continued text.") {
        mark = await revision(page)
        await page.keyboard.type(character)
        await accepted(page, mark)
      }
      const edited = await source(page)
      expect(edited.startsWith(before)).toBe(true)
      expect(edited.endsWith(after)).toBe(true)
      expect(edited).toContain("Continued text.")
      expect(edited).not.toContain("third")
      await load(page, edited, "mdx", "Continued text.")
      expect(await source(page)).toBe(edited)
    })
  }

  test("Enter and Tab in a list with blank lines between its items keep them", async ({ page }) => {
    let mark = await load(page, `${before}* first\n\n* second\n\n* third${after}`, "mdx", /^Before paragraph\.$/)
    await paragraph(page, /^second$/).click()
    await press(page, "End")
    await press(page, "Enter")
    await accepted(page, mark)
    for (const character of "added") {
      mark = await revision(page)
      await page.keyboard.type(character)
      await accepted(page, mark)
    }
    mark = await revision(page)
    await press(page, "Tab")
    await accepted(page, mark)
    await expect(frameOf(page).locator("li li")).toHaveText("added")
    expect(await source(page)).toBe(`${before}* first\n\n* second\n\n  * added\n\n* third${after}`)
  })

  test("simple lists stay compact while multi-paragraph items keep their spacing", async ({ page }) => {
    const spacing = `${before}* compact one\n* compact two\n\n1. ordered one\n2. ordered two\n\n* multiple first\n\n  multiple second\n\n  * nested child\n\n* multiple sibling${after}`
    await load(page, spacing, "mdx", /^compact one$/)
    const measured = await frameOf(page)
      .locator("body")
      .evaluate((root) =>
        [...root.querySelectorAll("p")]
          .filter((p) => p.getClientRects().length)
          .map((p) => {
            const css = getComputedStyle(p)
            const rect = p.getBoundingClientRect()
            return { text: p.textContent, inItem: Boolean(p.closest("li")), margins: parseFloat(css.marginTop) + parseFloat(css.marginBottom), marginBottom: parseFloat(css.marginBottom), top: rect.top, height: rect.height }
          }),
      )
    const row = (text: string) => measured.find((entry) => entry.text === text)!
    for (const text of ["compact one", "compact two", "ordered one", "ordered two"]) {
      expect(row(text).inItem, text).toBe(true)
      expect(row(text).margins, text).toBe(0)
    }
    expect(row("Before paragraph.").marginBottom).toBeGreaterThan(0)
    expect(row("multiple second").top - row("multiple first").top - row("multiple first").height).toBeGreaterThan(0)
    await expect(frameOf(page).locator("li li")).toHaveCount(1)
    expect(await source(page)).toBe(spacing)
  })
})

test("a diagram arriving while prose is being edited keeps the edit", async ({ page }) => {
  const note = '# Resource arrival\n\nOriginal editable prose.\n\n<Diagram src="flow.d2" />\n'
  await load(page, note, "mdx", /^Original editable prose\.$/)
  await expect(frameOf(page).getByText(/Preview unavailable for flow\.d2/)).toBeVisible()
  // Keep the edit uncommitted while the diagram's pixels arrive.
  await page.evaluate(() => {
    window.transactionGate.enabled = true
  })
  await paragraph(page, /^Original editable prose\.$/).click()
  await press(page, "End")
  await press(page, "Shift+Home")
  await page.keyboard.type("Draft survives arriving SVG")
  await page.waitForFunction(() => window.transactionGate.held.length > 0)
  await page.evaluate(() =>
    window.renderedHarness.setResources({
      "flow.d2": '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#36c"/></svg>',
    }),
  )
  await frameOf(page).locator("[data-resource-pixels]").first().waitFor()
  await expect(paragraph(page, /^Draft survives arriving SVG$/)).toBeVisible()
  expect(await releaseTransactions(page)).toBeGreaterThan(0)
  await expect.poll(() => source(page)).toBe(note.replace("Original editable prose.", "Draft survives arriving SVG"))
})

for (const [width, scheme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`at ${width}px in ${scheme}, the page and the note have no serious accessibility problems`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate((scheme) => window.renderedHarness.appearance("supabase-green", scheme), scheme)
    await fresh(page)
    await clickAt(page, plain, 0)
    await press(page, "Home")
    await press(page, "ArrowRight", 5)
    await press(page, "Shift+ArrowRight", 6)
    expect((await selection(page)).text).toBe(" bold ")
    for (const target of [page, page.frames().find((frame) => frame !== page.mainFrame())!]) {
      expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    }
    const results = await new AxeBuilder({ page }).analyze()
    const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    expect(serious.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
  })
}

test.describe("edits Markdown has to write with care", () => {
  // A list item shaped like a rough line quoted in italics, then plain text.
  const item = '- *Ann (draft): "Those limits really make logins weaker."* The fair version to start from: these limits push you into weak logins.'
  const note = `Intro paragraph.\n\n${item}\n- Another item.\n`
  const shown = 'Ann (draft): "Those limits really make logins weaker." The fair version to start from: these limits push you into weak logins.'

  test("deleting a selection from inside italics to the plain text after them deletes it, wherever it starts", async ({ page }) => {
    // From the start of a word, the closing `*` would sit after a space,
    // where Markdown cannot close italics: the space goes just outside them,
    // and the note takes that. After the quote, it would sit between
    // punctuation and a letter: the letter becomes a reference.
    for (const [from, key, written, italic] of [
      ["really", "Backspace", item.replace(/ really make .* from: /, "* "), 'Ann (draft): "Those limits'],
      ['Those', "Delete", item.replace(/Those .* from: t/, "*&#116;"), 'Ann (draft): "'],
      ["ally make", "Backspace", item.replace(/ally make .* from: /, "*"), 'Ann (draft): "Those limits re'],
    ] as const) {
      const mark = await load(page, note, "mdx", "Intro paragraph.")
      const start = await point(page, shown, shown.indexOf(from))
      const end = await point(page, shown, shown.indexOf("these"))
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 12 })
      await page.mouse.up()
      expect((await selection(page)).text, from).toBe(shown.slice(shown.indexOf(from), shown.indexOf("these")))
      await press(page, key)
      await accepted(page, mark)
      await expect.poll(() => source(page), { message: from }).toBe(note.replace(item, written))
      await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
      // The editor shows what the source holds, and so does the note opened again: the same words, the same italics.
      const after = `${shown.slice(0, shown.indexOf(from))}these limits push you into weak logins.`
      const showing = () => paragraph(page, "these limits push you").evaluate((p) => ({ shown: p.textContent, italic: p.querySelector("em")?.textContent }))
      await expect.poll(showing, { message: from }).toEqual({ shown: after, italic })
      await load(page, await source(page), "mdx", "these limits push you")
      expect(await showing(), from).toEqual({ shown: after, italic })
    }
  })

  test("bold on a word and the space after it, or taken off one word of a bold phrase, keeps the spaces outside the bold", async ({ page }) => {
    const note = "Intro.\n\nPlain one two three.\n\n**Bold one two three.**\n"
    const plainBold = note.replace("Plain one two three.", "Plain one **two** three.")
    let mark = await load(page, note, "mdx", "Intro.")
    // The word and the space after it, as a double-click selects them in some browsers.
    await clickAt(page, "Plain one two three.", 2)
    await press(page, "Home")
    await press(page, "ArrowRight", "Plain one ".length)
    await press(page, "Shift+ArrowRight", "two ".length)
    expect((await selection(page)).text).toBe("two ")
    await press(page, "ControlOrMeta+b")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe(plainBold)
    // One word in the middle of a bold phrase.
    mark = await revision(page)
    await clickAt(page, "Bold one two three.", 2)
    await press(page, "Home")
    await press(page, "ArrowRight", "Bold one ".length)
    await press(page, "Shift+ArrowRight", "two".length)
    expect((await selection(page)).text).toBe("two")
    await press(page, "ControlOrMeta+b")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe(plainBold.replace("**Bold one two three.**", "**Bold one** two **three.**"))
    await expect(paragraph(page, "Bold one two three.").locator("strong")).toHaveText(["Bold one", "three."])
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })

  test("Enter right before a space splits there, and the new paragraph or heading starts with the next word", async ({ page }) => {
    const note = "Intro.\n\nFirst sentence. Second sentence.\n\n## Two words\n\nEnd.\n"
    let mark = await load(page, note, "mdx", "End.")
    await clickAt(page, "First sentence. Second sentence.", 2)
    await press(page, "Home")
    await press(page, "ArrowRight", "First sentence.".length)
    await press(page, "Enter")
    await accepted(page, mark)
    // Markdown drops the space at the start of a paragraph: the source leaves it out, and so does the note.
    await expect.poll(() => source(page)).toBe(note.replace("First sentence. ", "First sentence.\n\n"))
    await expect(paragraph(page, /^Second sentence\.$/)).toBeVisible()
    expect((await selection(page)).focus).toEqual({ paragraph: "Second sentence.", offset: 0 })

    mark = await revision(page)
    await frameOf(page).locator(".ProseMirror > h2").filter({ hasText: "Two words" }).click()
    await press(page, "Home")
    await press(page, "ArrowRight", "Two".length)
    await press(page, "Enter")
    await accepted(page, mark)
    await expect(frameOf(page).locator(".ProseMirror > h2")).toHaveText(["Two", "words"])
    await expect.poll(() => source(page)).toBe(note.replace("First sentence. ", "First sentence.\n\n").replace("## Two words", "## Two\n\n## words"))
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })

  test("keys typed right after Enter before a space are all kept", async ({ page }) => {
    const note = "First sentence. Second sentence.\n"
    await load(page, note, "mdx", "First sentence.")
    await clickAt(page, "First sentence. Second sentence.", 2)
    await press(page, "Home")
    await press(page, "ArrowRight", "First sentence.".length)
    // The Enter waits with the app while the keys after it are typed.
    await page.evaluate(() => {
      window.transactionGate.enabled = true
    })
    await press(page, "Enter")
    await page.waitForFunction(() => window.transactionGate.held.length > 0)
    await page.keyboard.type("New. ")
    expect(await releaseTransactions(page)).toBe(1)
    await expect.poll(() => source(page)).toBe("First sentence.\n\nNew. Second sentence.\n")
    await expect(paragraph(page, /^New\. Second sentence\.$/)).toBeVisible()
    expect((await selection(page)).focus).toEqual({ paragraph: "New. Second sentence.", offset: "New. ".length })
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })

  test("Enter at the start of a heading puts an empty paragraph above it, and typing goes on in the heading", async ({ page }) => {
    const sections = "## Top heading\n\nIntro paragraph.\n\n## 2. Second part\n\nBody text.\n"
    for (const [heading, written] of [
      ["2. Second part", sections.replace("## 2.", "\n\n## X2.")],
      ["Top heading", `\n\n\n\n${sections.replace("## Top", "## XTop")}`],
    ] as const) {
      let mark = await load(page, sections, "mdx", "Body text.")
      const target = frameOf(page).locator(".ProseMirror > h2").filter({ hasText: heading })
      await target.click()
      await press(page, "Home")
      await press(page, "Enter")
      await accepted(page, mark)
      await expect(target).toHaveText(heading)
      expect(await target.evaluate((h2) => [h2.previousElementSibling?.tagName, h2.previousElementSibling?.textContent]), heading).toEqual(["P", ""])
      mark = await revision(page)
      await page.keyboard.type("X")
      await accepted(page, mark)
      await expect.poll(() => source(page), { message: heading }).toBe(written)
      await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
    }
  })

  test("Enter at the start of the note's first paragraph, or on a selected table, adds an empty paragraph there", async ({ page }) => {
    const first = "First paragraph.\n\nMore text.\n"
    let mark = await load(page, first, "mdx", "More text.")
    await clickAt(page, "First paragraph.", 2)
    await press(page, "Home")
    await press(page, "Enter")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe(`\n\n\n\n${first}`)

    const table = "Intro.\n\n| A | B |\n| --- | --- |\n| x | y |\n\nMore text.\n"
    mark = await load(page, table, "mdx", "More text.")
    await clickAt(page, "Intro.", 2)
    await press(page, "End")
    // The arrow selects the table; Enter adds an empty paragraph after it, with the caret there.
    await press(page, "ArrowRight")
    await press(page, "Enter")
    await accepted(page, mark)
    mark = await revision(page)
    await page.keyboard.type("Z")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe(table.replace("| x | y |\n", "| x | y |\n\nZ\n"))
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })

  test("an edit Markdown cannot hold is undone with a plain reason, and the check's own message goes to the console", async ({ page }) => {
    const warnings: string[] = []
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text())
    })
    // Enter at the start of a line the source wraps would end the paragraph
    // before it with that line break, which Markdown drops.
    const wrapped = "Intro.\n\nFirst line\nsecond line.\n\nMore text.\n"
    await load(page, wrapped, "mdx", "More text.")
    await clickAt(page, "First line\nsecond line.", "First line\nsec".length)
    await press(page, "Home")
    expect((await selection(page)).focus).toEqual({ paragraph: "First line\nsecond line.", offset: "First line\n".length })
    await press(page, "Enter")
    const notice = page.getByRole("status").filter({ hasText: /^Edit not applied:/ })
    await expect(notice).toHaveText(`Edit not applied: ${UNWRITABLE}`)
    await expect(paragraph(page, "First line\nsecond line.")).toBeVisible()
    expect(await source(page)).toBe(wrapped)
    expect(warnings.join("\n")).toContain("Source projection differs from proposed editor transaction")
  })

  test("a second Enter on the empty line Enter made between two blocks does nothing, and says nothing", async ({ page }) => {
    const note = "First paragraph.\n\nSecond paragraph.\n"
    let mark = await load(page, note, "mdx", "Second paragraph.")
    await clickAt(page, "First paragraph.", 2)
    await press(page, "End")
    await press(page, "Enter")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("First paragraph.\n\n\n\nSecond paragraph.\n")
    // Markdown keeps one empty paragraph between two blocks: the caret stays on that one, where typing goes.
    // No notice shows, not even for a moment.
    await page.evaluate(() => {
      const seen = { notice: false }
      ;(window as unknown as { seen: typeof seen }).seen = seen
      new MutationObserver(() => {
        if (document.body.textContent?.includes("Edit not applied:")) seen.notice = true
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    mark = await revision(page)
    await press(page, "Enter")
    await page.keyboard.type("Z")
    await accepted(page, mark)
    await expect.poll(() => source(page)).toBe("First paragraph.\n\nZ\n\nSecond paragraph.\n")
    await expect(frameOf(page).locator(".ProseMirror > p")).toHaveText(["First paragraph.", "Z", "Second paragraph."])
    expect(await page.evaluate(() => (window as unknown as { seen: { notice: boolean } }).seen.notice)).toBe(false)
  })

  test("Enter at the start of a line in a quote puts an empty paragraph just outside the quote, and typing goes on in the quote", async ({ page }) => {
    const quote = "Intro.\n\n> A quoted line.\n\nMore text.\n"
    const lines = "> First line.\n>\n> Second line.\n\nMore text.\n"
    for (const [note, line, written] of [
      // At its first line, above the quote.
      [quote, "A quoted line.", quote.replace("> A quoted", "\n\n> XA quoted")],
      // At a later line, between the quote's two parts.
      [lines, "Second line.", lines.replace("\n>\n> Second", "\n\n\n\n> XSecond")],
    ] as const) {
      let mark = await load(page, note, "mdx", "More text.")
      await clickAt(page, line, 2)
      await press(page, "Home")
      await press(page, "Enter")
      await accepted(page, mark)
      const quoted = frameOf(page).locator(".ProseMirror > blockquote").filter({ hasText: line })
      await expect(quoted).toHaveText(line)
      expect(await quoted.evaluate((element) => [element.previousElementSibling?.tagName, element.previousElementSibling?.textContent]), line).toEqual(["P", ""])
      expect((await selection(page)).focus, line).toEqual({ paragraph: line, offset: 0 })
      mark = await revision(page)
      await page.keyboard.type("X")
      await accepted(page, mark)
      await expect.poll(() => source(page), { message: line }).toBe(written)
      await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
    }
  })
})

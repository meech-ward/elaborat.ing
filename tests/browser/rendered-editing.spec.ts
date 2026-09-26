import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
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

const prefix = "export const untouched = 7;\n\n{/* preserve  this comment */}\n\n"
const first = "Start **bold** and *emphasis* plus `code` and [link](https://example.com) end."
const plain = "Start bold and emphasis plus code and link end."
const second = "Second paragraph tail."
const suffix = "\n\n- First list item\n- Second list item\n\n<Counter initial={untouched} />\n\nUntouched tail.\n"
const original = `${prefix}${first}\n\n${second}${suffix}`

test.use({ viewport: { width: 1280, height: 900 } })

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
    // Let the caret settle first: in Chromium, Enter within milliseconds of
    // arrow keys can split at the previous caret position (task T10).
    await expect.poll(async () => (await selection(page)).focus?.offset).toBe(5)
    await frameOf(page).locator("body").evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))))
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
        window.addEventListener("message", (event) => {
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
    const notice = page.getByText(/Selection crosses a protected object/).first()
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute("role", "status")
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
    await page.evaluate((scheme) => window.renderedHarness.appearance("studio", scheme), scheme)
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

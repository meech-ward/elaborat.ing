import { expect, test, type Locator, type Page } from "./fixtures.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { clickAt, frameOf, load, openHarness, paragraph, recordFrameMessages, revision, settled, source } from "./rendered-support.ts"
import { APP_URL, SANDBOX_URL } from "./urls.ts"

// The rendered note stays still while it is edited: an edit renders again
// only what it changed. Elements are marked before an edit and looked for
// after it: a marked element still on screen was kept, not made again.

/** Mark an element in the frame, to tell later whether it is the same one. */
const mark = (target: Locator) => target.evaluate((element) => ((element as Element & { __kept?: boolean }).__kept = true))
/** Whether the element is the one marked before, still on screen. */
const kept = (target: Locator) => target.evaluate((element) => (element as Element & { __kept?: boolean }).__kept === true && element.isConnected)

/** Each distinct top the paragraph starting with `text` has had, from now until `stop` resolves, sampled every frame. */
async function tops(page: Page, text: string, stop: () => Promise<unknown>) {
  await frameOf(page)
    .locator("body")
    .evaluate((body, text) => {
      const seen: number[] = []
      const state = { seen, running: true }
      ;(window as Window & { __tops?: typeof state }).__tops = state
      const sample = () => {
        const element = [...body.querySelectorAll("p")].find((p) => p.textContent?.startsWith(text))
        const top = element ? Math.round(element.getBoundingClientRect().top) : -1
        if (seen.at(-1) !== top) seen.push(top)
        if (state.running) requestAnimationFrame(sample)
      }
      sample()
    }, text)
  await stop()
  return frameOf(page)
    .locator("body")
    .evaluate(() => {
      const state = (window as Window & { __tops?: { seen: number[]; running: boolean } }).__tops!
      state.running = false
      return state.seen
    })
}

test.describe("in the harness", () => {
  test.use({ serviceWorkers: "allow", viewport: { width: 1280, height: 900 } })
  // Some journeys load a chart and boot an embedded document's own frame.
  test.describe.configure({ timeout: 60_000 })

  const islands = `Lead paragraph here.

<Counter initial={1} />

\`\`\`js
const total = 40 + 35
\`\`\`

<ChartContainer config={{ apples: { label: "Apples", color: "rgb(200, 60, 40)" } }} aria-label="Fruit orders">
  <BarChart data={[{ month: "Jan", apples: 3 }, { month: "Feb", apples: 5 }]}>
    <Bar dataKey="apples" fill="var(--color-apples)" />
  </BarChart>
</ChartContainer>

<Document src="notes/details.md" title="Details" />

| a | b |
| --- | --- |
| one | two |

Tail paragraph here.
`

  test("editing one island keeps the others as they were: a counter's count, a chart, a table and an embedded document", async ({ page }) => {
    await openHarness(page)
    await page.evaluate(() => window.renderedHarness.setEmbeddedDocuments({ "notes/details.md": "# Details\n\nChild paragraph one.\n" }))
    await load(page, islands, "mdx", "Lead paragraph here.")
    const frame = frameOf(page)
    await expect(frame.locator(".document-chart svg .recharts-bar-rectangle")).toHaveCount(2)
    await expect(frame.locator(".document-code-highlight")).toHaveCount(1)
    // An embedded document boots a frame of its own, which can take a while on a busy machine.
    await expect(frame.frameLocator('iframe[title^="Embedded document"]').getByText("Child paragraph one.")).toBeVisible({ timeout: 20_000 })
    await frame.getByRole("button", { name: "Increment" }).click()
    const count = frame.locator('[data-component="Counter"] output')
    await expect(count).toHaveText("2")
    const chart = frame.locator(".document-chart svg").first()
    const embed = frame.locator('iframe[title^="Embedded document"]')
    const table = frame.locator("table")
    const code = frame.locator(".document-code")
    for (const target of [count, chart, embed, table]) await mark(target)
    const sentBefore = await page.evaluate(() => window.frameMessages.length)

    // Edit the code block: its island is made again, and only it.
    await frame.getByRole("button", { name: "Edit code", exact: true }).click()
    const editor = frame.locator("textarea.document-code-editor")
    await expect(editor).toBeFocused()
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length))
    await page.keyboard.type(" // x")
    await clickAt(page, "Tail paragraph here.", 3)
    await expect.poll(() => source(page)).toContain("const total = 40 + 35 // x")
    await settled(page)
    await expect(frame.locator(".document-code-highlight")).toContainText("// x")
    await expect(count).toHaveText("2")
    for (const target of [count, chart, embed, table]) expect(await kept(target)).toBe(true)

    // Edit a table cell: now the code block is kept too.
    await mark(code)
    const cell = frame.locator("td").filter({ hasText: "one" }).locator('[role="textbox"]')
    const box = (await cell.boundingBox())!
    await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
    await page.keyboard.type("x")
    await clickAt(page, "Tail paragraph here.", 3)
    await expect.poll(() => source(page)).toContain("| onex | two |")
    await settled(page)
    await expect(count).toHaveText("2")
    for (const target of [count, chart, embed, code]) expect(await kept(target)).toBe(true)

    // The embedded document was never released and loaded again.
    const sent = await page.evaluate((from) => window.frameMessages.slice(from).map((message) => message.kind), sentBefore)
    expect(sent).not.toContain("document-embed-release")
  })

  test("a code block being edited keeps its text when another island changes, and commits once", async ({ page }) => {
    await openHarness(page)
    const note = (first: string) => `Lead paragraph here.\n\n\`\`\`js\n${first}\n\`\`\`\n\n\`\`\`js\nconst second = 2\n\`\`\`\n\nTail paragraph here.\n`
    await load(page, note("const first = 1"), "mdx", "Lead paragraph here.")
    const frame = frameOf(page)
    await expect(frame.locator(".document-code-highlight")).toHaveCount(2)
    await frame.getByRole("button", { name: "Edit code", exact: true }).nth(1).click()
    const editor = frame.locator("textarea.document-code-editor")
    await expect(editor).toBeFocused()
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length))
    await page.keyboard.type(" // draft")
    await mark(editor)
    // The other code block changes in Source meanwhile.
    await page.evaluate((text) => window.renderedHarness.edit(text), note("const first = 10"))
    await expect(frame.locator(".document-code-highlight").first()).toContainText("const first = 10")
    expect(await kept(editor)).toBe(true)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue("const second = 2 // draft")
    await clickAt(page, "Tail paragraph here.", 3)
    await expect.poll(() => source(page)).toBe(note("const first = 10").replace("const second = 2", "const second = 2 // draft"))
  })

  test("typing in prose renders no island again: a code block keeps its scroll, a chart its drawing", async ({ page }) => {
    await openHarness(page)
    const long = `const line = "${"a long line that does not fit ".repeat(8)}"`
    await load(page, `Lead paragraph here.

\`\`\`js
${long}
\`\`\`

<ChartContainer config={{ apples: { label: "Apples", color: "rgb(200, 60, 40)" } }} aria-label="Fruit orders">
  <BarChart data={[{ month: "Jan", apples: 3 }, { month: "Feb", apples: 5 }]}>
    <Bar dataKey="apples" fill="var(--color-apples)" />
  </BarChart>
</ChartContainer>

Tail paragraph here.
`, "mdx", "Lead paragraph here.")
    const frame = frameOf(page)
    const pre = frame.locator(".document-code-highlight pre")
    await expect(pre).toHaveCount(1)
    await expect(frame.locator(".document-chart svg .recharts-bar-rectangle")).toHaveCount(2)
    // Let the chart's first drawing finish.
    await page.waitForTimeout(1000)
    await pre.evaluate((element) => (element.scrollLeft = 150))
    const bars = frame.locator(".recharts-bar-rectangles .recharts-layer").first()
    await mark(pre)
    await mark(bars)
    await frame.locator("body").evaluate(() => {
      const changes = { count: 0 }
      ;(window as Window & { __islandChanges?: typeof changes }).__islandChanges = changes
      for (const island of document.querySelectorAll("[data-fluid-object]"))
        new MutationObserver((records) => (changes.count += records.length)).observe(island, { subtree: true, childList: true, attributes: true, characterData: true })
    })

    await clickAt(page, "Lead paragraph here.", 19)
    await page.keyboard.type(" More")
    await expect.poll(() => source(page)).toContain("Lead paragraph here More.")
    await settled(page)

    expect(await kept(pre)).toBe(true)
    expect(await pre.evaluate((element) => element.scrollLeft)).toBe(150)
    expect(await kept(bars)).toBe(true)
    expect(await frame.locator("body").evaluate(() => (window as Window & { __islandChanges?: { count: number } }).__islandChanges!.count)).toBe(0)
  })

  test("the Insert block dialog lists the note's positions only while it is open", async ({ page }) => {
    await openHarness(page)
    const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n")
    await load(page, `${paragraphs}\n`, "md", "Paragraph 1.")
    const frame = frameOf(page)
    const dialog = frame.getByRole("dialog", { name: "Insert block" })
    await frame.locator("body").evaluate(() => {
      const changes = { count: 0 }
      ;(window as Window & { __dialogChanges?: typeof changes }).__dialogChanges = changes
      new MutationObserver((records) => (changes.count += records.length)).observe(document.querySelector("dialog")!, { subtree: true, childList: true, attributes: true })
    })
    await clickAt(page, "Paragraph 1.", 0)
    await page.keyboard.type("New ")
    await expect.poll(() => source(page)).toContain("New Paragraph 1.")
    await settled(page)
    // Typing changes every position after the caret, but nothing in the closed dialog.
    expect(await frame.locator("body").evaluate(() => (window as Window & { __dialogChanges?: { count: number } }).__dialogChanges!.count)).toBe(0)

    await frame.getByRole("button", { name: "+ Insert block" }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel("Block type")).toBeFocused()
    await expect(dialog.getByLabel("Insert position").locator("option")).toHaveCount(31)
    await expect(dialog.getByLabel("Insert position").locator("option:checked")).toHaveText("After block 30")
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
  })

  test("Edit code takes the block's place at its height, and grows with each line typed", async ({ page }) => {
    await openHarness(page)
    await load(page, `Lead paragraph here.

\`\`\`js
const one = 1
\`\`\`

After one line.

\`\`\`js
const a = 1
const b = 2
const c = 3
const d = 4
const e = 5
\`\`\`

After five lines.
`, "mdx", "Lead paragraph here.")
    const frame = frameOf(page)
    await expect(frame.locator(".document-code-highlight")).toHaveCount(2)
    const top = (text: string) => paragraph(page, text).evaluate((element) => element.getBoundingClientRect().top)
    const editor = frame.locator("textarea.document-code-editor")
    for (const [index, after] of [[0, "After one line."], [1, "After five lines."]] as const) {
      const before = await top(after)
      await frame.getByRole("button", { name: "Edit code", exact: true }).nth(index).click()
      await expect(editor).toBeFocused()
      expect(Math.abs((await top(after)) - before)).toBeLessThanOrEqual(1)
      await page.keyboard.press("Escape")
      await expect(editor).toHaveCount(0)
      expect(Math.abs((await top(after)) - before)).toBeLessThanOrEqual(1)
    }

    // A line typed grows the editor by a line, and the block it commits to is as tall.
    const before = await top("After five lines.")
    await frame.getByRole("button", { name: "Edit code", exact: true }).nth(1).click()
    await expect(editor).toBeFocused()
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length))
    await page.keyboard.press("Enter")
    await page.keyboard.type("const f = 6")
    const line = await editor.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight))
    const editing = await top("After five lines.")
    expect(Math.abs(editing - before - line)).toBeLessThanOrEqual(1)
    await clickAt(page, "After five lines.", 2)
    await expect.poll(() => source(page)).toContain("const e = 5\nconst f = 6\n```")
    await settled(page)
    await expect(frame.locator(".document-code-highlight").nth(1)).toContainText("const f = 6")
    expect(Math.abs((await top("After five lines.")) - editing)).toBeLessThanOrEqual(1)
  })

  test("an embedded document loads in one box, and a view of it that starts again keeps its height", async ({ page }) => {
    await openHarness(page)
    const child = `# Details\n\n${Array.from({ length: 12 }, (_, index) => `Child paragraph ${index + 1}.`).join("\n\n")}\n`
    await page.evaluate((child) => window.renderedHarness.setEmbeddedDocuments({ "notes/details.md": child }), child)
    const note = (title: string) => `# Parent\n\nBefore.\n\n<Document src="notes/details.md" title="${title}" defaultCollapsed />\n\nAfter paragraph here.\n`
    await load(page, note("Details"), "mdx", "After paragraph here.")
    const frame = frameOf(page)
    const embed = frame.frameLocator('iframe[title^="Embedded document"]')
    const loaded = async () => {
      await expect(embed.getByText("Child paragraph 12.")).toBeVisible()
      // The frame takes the document's height once it has laid out.
      await expect.poll(() => frame.locator('iframe[title^="Embedded document"]').evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(300)
      await page.waitForTimeout(300)
    }
    const start = await paragraph(page, "After paragraph here.").evaluate((element) => Math.round(element.getBoundingClientRect().top))
    // Expanding opens one box, which the document then fills: the status
    // while it loads and the frame it loads into are the same size.
    const opening = await tops(page, "After paragraph here.", async () => {
      await frame.getByRole("button", { name: "Details" }).click()
      await loaded()
    })
    expect(opening.filter((top) => top !== start)).toHaveLength(2)

    // Its line changes, so the view starts again, at the height it had.
    const height = await frame.locator('iframe[title^="Embedded document"]').evaluate((element) => element.getBoundingClientRect().height)
    const again = await tops(page, "After paragraph here.", async () => {
      await page.evaluate((text) => window.renderedHarness.edit(text), note("Details again").replace(" defaultCollapsed", ""))
      await expect(frame.getByRole("button", { name: "Details again" })).toBeVisible()
      await loaded()
    })
    expect(again).toHaveLength(1)
    expect(await frame.locator('iframe[title^="Embedded document"]').evaluate((element) => element.getBoundingClientRect().height)).toBe(height)
  })

  for (const mode of ["srcdoc", "sandbox domain"] as const) {
    test(`the note's first paint in the ${mode} frame is already in its fonts`, async ({ page }) => {
      // In each frame, when the note's text first appears: are its fonts there?
      await page.addInitScript(() => {
        const fonts = { seen: false, text: false, code: false }
        ;(window as Window & { __firstFonts?: typeof fonts }).__firstFonts = fonts
        const observer = new MutationObserver(() => {
          if (!document.querySelector(".ProseMirror")?.textContent) return
          observer.disconnect()
          fonts.seen = true
          fonts.text = document.fonts.check('15px "Space Grotesk Variable"')
          fonts.code = document.fonts.check('13px "JetBrains Mono Variable"')
        })
        observer.observe(document, { childList: true, subtree: true, characterData: true })
      })
      await openHarness(page, mode === "sandbox domain" ? `?sandbox=${encodeURIComponent(new URL(SANDBOX_URL).origin)}` : "")
      await expect(page.locator('iframe[title="Isolated document preview"]')).toBeAttached()
      await load(page, "# Fonts\n\nThe quick brown fox jumps over the lazy dog, twice over in a long line.\n\n```js\nconst fox = 1\n```\n", "mdx", "The quick brown fox")
      const fonts = await frameOf(page).locator("body").evaluate(() => (window as Window & { __firstFonts?: object }).__firstFonts)
      expect(fonts).toEqual({ seen: true, text: true, code: true })
    })
  }

  test("a note whose own text calls a hook keeps rendering as its islands change", async ({ page }) => {
    await openHarness(page)
    const note = (values: number[]) => `import { useState } from 'react'

Before paragraph.

${values.map((value) => `{useState(${value})[0]}`).join("\n\n")}

\`\`\`js
const a = 1
\`\`\`

After paragraph.
`
    await load(page, note([5]), "mdx", "After paragraph.")
    const frame = frameOf(page)
    await expect(frame.locator("[data-fluid-object]").filter({ hasText: /^5$/ })).toHaveCount(1)
    // Another island calls one more hook from the note's own text, then none.
    for (const values of [[5, 7], [], [9]]) {
      await page.evaluate((text) => window.renderedHarness.edit(text), note(values))
      for (const value of values) await expect(frame.locator("[data-fluid-object]").filter({ hasText: new RegExp(`^${value}$`) })).toHaveCount(1)
      await expect(paragraph(page, "After paragraph.")).toBeVisible()
    }
    expect(await page.evaluate(() => window.frameMessages.filter((message) => message.kind === "render-error").length)).toBe(0)
    expect(await page.evaluate(() => window.renderedHarness.state().error)).toBeNull()
  })

  test("an image whose pixels go missing for a moment keeps its box", async ({ page }) => {
    await openHarness(page)
    await load(page, "# Pictures\n\nAnchor paragraph.\n\n![A picture](pic.png)\n\nAfter paragraph.\n", "md", "After paragraph.")
    const frame = frameOf(page)
    // The revisions the page has sent the frame pixels for (none: the
    // harness has no images of its own), and pixels to send as the app would.
    await frame.locator("body").evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 400
      canvas.height = 300
      const context = canvas.getContext("2d")!
      context.fillStyle = "#c33"
      context.fillRect(0, 0, 400, 300)
      const state = {
        revisions: [] as number[],
        send: (session: string, revision: number) =>
          window.pagePort!.dispatchEvent(new MessageEvent("message", { data: { kind: "images", session, revision, reset: true, images: [{ key: "pic.png", dataURL: canvas.toDataURL("image/png"), width: 400, height: 300 }] } })),
      }
      ;(window as Window & { __pixels?: typeof state }).__pixels = state
      window.pagePort!.addEventListener("message", (event) => {
        if (event.data?.kind === "images") state.revisions.push(event.data.revision)
      })
    })
    const imagesFor = (revision: number) =>
      expect.poll(() => frame.locator("body").evaluate((body, revision) => (window as Window & { __pixels?: { revisions: number[] } }).__pixels!.revisions.includes(revision), revision)).toBe(true)
    await clickAt(page, "Anchor paragraph.", 0)
    await page.keyboard.type("A")
    await expect.poll(() => source(page)).toContain("AAnchor paragraph.")
    await settled(page)
    const shown = await revision(page)
    await imagesFor(shown.revision)
    await frame.locator("body").evaluate((body, shown) => (window as Window & { __pixels?: { send: (session: string, revision: number) => void } }).__pixels!.send(shown.session, shown.revision), shown)
    const image = frame.getByRole("img", { name: "A picture" })
    await expect(image).toHaveJSProperty("naturalWidth", 400)
    const before = await paragraph(page, "After paragraph.").evaluate((element) => element.getBoundingClientRect().top)
    // The harness sends the next revision without pixels: the image's box stays.
    await page.keyboard.type("B")
    await expect.poll(() => source(page)).toContain("ABAnchor paragraph.")
    await settled(page)
    await imagesFor(shown.revision + 1)
    await expect(frame.locator(".project-image-missing")).toBeVisible()
    expect(Math.abs((await paragraph(page, "After paragraph.").evaluate((element) => element.getBoundingClientRect().top)) - before)).toBeLessThanOrEqual(1)
  })
})

test.describe("in the app", () => {
  test.use({ viewport: { width: 1280, height: 900 } })
  test.describe.configure({ timeout: 60_000 })
  const FRAME = 'iframe[title="Isolated document preview"]:visible'
  const frame = (page: Page) => page.frameLocator(FRAME)
  const lines = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

  test("typing after an image keeps the same picture on screen, and nothing below it moves", async ({ page }) => {
    await recordFrameMessages(page)
    await fakeSupabase(page)
    await page.goto(APP_URL)
    await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Local project" })).toBeVisible()
    await page.getByRole("button", { name: "New file" }).click()
    await page.getByRole("menuitem", { name: "New note", exact: true }).click()
    await page.getByRole("textbox", { name: /^Name of the new note in / }).fill("pictures.mdx")
    await page.keyboard.press("Enter")
    await expect(lines(page)).toBeVisible()
    await lines(page).click()
    await page.keyboard.type("# Pictures\n\nAnchor paragraph.\n\nAfter paragraph.\n")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("tab", { name: "pictures.mdx", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Rendered", exact: true }).click()
    await expect(frame(page).getByText("Anchor paragraph.", { exact: true })).toBeVisible()

    // A 400 by 300 picture, uploaded after the first paragraph.
    const dataURL = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 400
      canvas.height = 300
      const context = canvas.getContext("2d")!
      context.fillStyle = "#c33"
      context.fillRect(0, 0, 400, 300)
      return canvas.toDataURL("image/png")
    })
    await frame(page).getByText("Anchor paragraph.", { exact: true }).click({ button: "right" })
    await frame(page).getByRole("menu", { name: "Insert block" }).getByRole("menuitem", { name: "Image", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Insert image", exact: true })
    await dialog.getByLabel("Upload images", { exact: true }).setInputFiles({ name: "red.png", mimeType: "image/png", buffer: Buffer.from(dataURL.split(",")[1], "base64") })
    await expect(dialog.getByLabel("Image description", { exact: true })).toBeEnabled()
    await dialog.getByLabel("Image description", { exact: true }).fill("A red picture")
    await dialog.getByRole("button", { name: "Insert image", exact: true }).click()
    await expect(dialog).toBeHidden()
    const image = frame(page).getByRole("img", { name: "A red picture", exact: true })
    await expect(image).toHaveJSProperty("complete", true)

    // Clicked past its end, the caret goes at the end of the paragraph after the picture.
    await frame(page).getByText("After paragraph.", { exact: true }).click()
    const after = frame(page).locator("p").filter({ hasText: "After paragraph." })
    await mark(image)
    const before = await after.evaluate((element) => element.getBoundingClientRect().top)
    await frame(page).locator("body").evaluate(() => {
      const changes = { placeholders: 0, removed: 0 }
      ;(window as Window & { __imageChanges?: typeof changes }).__imageChanges = changes
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof Element && node.matches(".project-image-missing")) changes.placeholders++
          for (const node of record.removedNodes) if (node instanceof Element && (node.matches("img") || node.querySelector("img"))) changes.removed++
        }
      }).observe(document.body, { childList: true, subtree: true })
    })
    for (const key of "typed") {
      await page.keyboard.type(key)
      await page.waitForTimeout(60)
    }
    await expect(after).toContainText("typed")
    await page.waitForTimeout(500)

    expect(await kept(image)).toBe(true)
    expect(await frame(page).locator("body").evaluate(() => (window as Window & { __imageChanges?: object }).__imageChanges)).toEqual({ placeholders: 0, removed: 0 })
    expect(Math.abs((await after.evaluate((element) => element.getBoundingClientRect().top)) - before)).toBeLessThanOrEqual(1)
  })
})

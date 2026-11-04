import { expect, test, type Locator, type Page } from "./fixtures.ts"
import { textAnchor } from "../../src/features/comments/placement.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { clickAt, frameOf, load, openHarness, paragraph, press, recordFrameMessages, revision, settled, source } from "./rendered-support.ts"
import { APP_URL, SANDBOX_URL } from "./urls.ts"

// The rendered note stays still while it is edited: an edit renders again
// only what it changed. Elements are marked before an edit and looked for
// after it: a marked element still on screen was kept, not made again.

/** Mark an element in the frame, to tell later whether it is the same one. */
const mark = (target: Locator) => target.evaluate((element) => ((element as Element & { __kept?: boolean }).__kept = true))
/** Whether the element is the one marked before, still on screen. */
const kept = (target: Locator) => target.evaluate((element) => (element as Element & { __kept?: boolean }).__kept === true && element.isConnected)

type PagePost = { kind: string; size: number; doc: boolean; code: boolean; modules: boolean; components: boolean }
/** From the next page load on, record in each note frame what the page sends it, and how big each message is. */
const recordPagePosts = (page: Page) =>
  page.addInitScript(() => {
    if (window === window.top) return
    const posts: PagePost[] = []
    Object.assign(window, { __pagePosts: posts })
    window.addEventListener("message", (event) => {
      if (event.data?.kind !== "connect") return
      event.ports[0]?.addEventListener("message", ({ data }) => {
        posts.push({
          kind: String(data?.kind),
          size: JSON.stringify(data).length,
          doc: data?.fluid?.doc !== undefined,
          code: data?.code !== undefined,
          modules: data?.modules !== undefined,
          components: data?.authoring?.components !== undefined,
        })
      })
    })
  })
const pagePosts = (page: Page) => frameOf(page).locator("body").evaluate(() => (window as unknown as { __pagePosts: PagePost[] }).__pagePosts)

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
    // A 400 by 300 picture's pixels, given to the editor as the workbench does.
    const dataURL = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 400
      canvas.height = 300
      const context = canvas.getContext("2d")!
      context.fillStyle = "#c33"
      context.fillRect(0, 0, 400, 300)
      return canvas.toDataURL("image/png")
    })
    await page.evaluate((dataURL) => window.renderedHarness.setImages({ "pic.png": { dataURL, width: 400, height: 300 } }), dataURL)
    const image = frame.getByRole("img", { name: "A picture" })
    await expect(image).toHaveJSProperty("naturalWidth", 400)
    const before = await paragraph(page, "After paragraph.").evaluate((element) => element.getBoundingClientRect().top)
    // Its pixels go for a moment (the page has none for it): the image's box stays.
    await page.evaluate(() => window.renderedHarness.setImages({}))
    await expect(frame.locator(".project-image-missing")).toBeVisible()
    expect(Math.abs((await paragraph(page, "After paragraph.").evaluate((element) => element.getBoundingClientRect().top)) - before)).toBeLessThanOrEqual(1)
  })

  for (const [scheme, mode] of [["light", "srcdoc"], ["dark", "srcdoc"], ["light", "sandbox domain"]] as const) {
    test(`a new note's frame shows the page's own panel colour until its ${scheme} palette has come, then the note in it (${mode} frame)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      // In each frame, at each paint: its page's background and scheme, and
      // whether the note is there; and what the page said, in order.
      await page.addInitScript(() => {
        if (window === window.top) return
        const paints: { background: string; scheme?: string; text: boolean }[] = []
        const said: string[] = []
        Object.assign(window, { __paints: paints, __said: said })
        const sample = () => {
          paints.push({
            background: document.body ? getComputedStyle(document.body).backgroundColor : "none",
            scheme: document.documentElement.dataset.scheme,
            text: Boolean(document.getElementById("root")?.textContent),
          })
          if (paints.length < 600) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
        window.addEventListener("message", (event) => {
          if (event.data?.kind === "connect") event.ports[0]?.addEventListener("message", (message) => said.push(String(message.data?.kind)))
        })
      })
      await openHarness(page, mode === "sandbox domain" ? `?sandbox=${encodeURIComponent(new URL(SANDBOX_URL).origin)}` : "")
      await page.evaluate((scheme) => window.renderedHarness.appearance("supabase-green", scheme), scheme)
      // A note in a new frame (each note gets its own).
      await load(page, `# Pictures\n\n${Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} of the note.`).join("\n\n")}\n`, "md", "Paragraph 1 of the note.")
      const frame = frameOf(page)
      await expect(frame.locator("html")).toHaveAttribute("data-scheme", scheme)
      const { paints, said } = await frame.locator("body").evaluate(() => {
        const seen = window as unknown as { __paints: { background: string; scheme?: string; text: boolean }[]; __said: string[] }
        return { paints: seen.__paints, said: seen.__said }
      })
      const panel = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("div"))
        probe.style.background = "var(--panel)"
        const colour = getComputedStyle(probe).backgroundColor
        probe.remove()
        return colour
      })
      // The frame's page is see-through, with nothing on it, until the palette
      // comes; from then on it is the page's panel colour, in that palette.
      const until = paints.findIndex((paint) => paint.scheme !== undefined)
      expect(until).toBeGreaterThanOrEqual(0)
      expect(paints.slice(0, until).filter((paint) => paint.background !== "rgba(0, 0, 0, 0)" || paint.text)).toEqual([])
      expect(paints.slice(until).filter((paint) => paint.scheme !== scheme || paint.background !== panel)).toEqual([])
      // Behind it, the frame's element is that colour, with no scheme of its
      // own: one that differs from the page's makes the browser paint it opaque.
      expect(await page.locator('iframe[title="Isolated document preview"]').evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, scheme: getComputedStyle(element).colorScheme }))).toEqual({ background: panel, scheme: "normal" })
      // The palette and the reading preferences came before the note.
      expect(said.indexOf("appearance")).toBeGreaterThanOrEqual(0)
      expect(said.indexOf("appearance")).toBeLessThan(said.indexOf("render"))
      expect(said.indexOf("reading-preferences")).toBeLessThan(said.indexOf("render"))
    })
  }

  test("an edit's answer is a small ack, without the note's document, code or components, and nothing else is sent again", async ({ page }) => {
    await recordPagePosts(page)
    await openHarness(page)
    const paragraphs = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1} has enough words in it to make the note a long one to send.`).join("\n\n")
    await load(page, `Lead paragraph here.\n\n<Counter initial={1} />\n\n\`\`\`js\nconst total = 40 + 35\n\`\`\`\n\n${paragraphs}\n`, "mdx", "Lead paragraph here.")
    const frame = frameOf(page)
    await frame.getByRole("button", { name: "Increment" }).click()
    await expect(frame.locator('[data-component="Counter"] output')).toHaveText("2")
    await clickAt(page, "Lead paragraph here.", 19)
    await settled(page)
    const from = (await pagePosts(page)).length
    for (const key of "abcde") {
      await page.keyboard.type(key)
      await page.waitForTimeout(100)
    }
    await expect.poll(() => source(page)).toContain("Lead paragraph hereabcde.")
    await settled(page)
    await expect(paragraph(page, "Lead paragraph hereabcde.")).toBeVisible()
    await expect(frame.locator('[data-component="Counter"] output')).toHaveText("2")
    const posts = await pagePosts(page)
    const whole = posts.findLast((post, index) => index < from && post.kind === "render")!
    const typing = posts.slice(from)
    expect(typing.length).toBeGreaterThan(0)
    expect(typing.length).toBeLessThanOrEqual(5)
    for (const post of typing) {
      expect(post).toMatchObject({ kind: "render-ack", doc: false, code: false, modules: false, components: false })
      expect(post.size).toBeLessThan(whole.size / 3)
    }
  })

  test("a frame sent an ack it cannot place asks for the whole render, and typing goes on", async ({ page }) => {
    await recordPagePosts(page)
    await openHarness(page)
    await load(page, "Lead paragraph here.\n\nTail paragraph here.\n", "mdx", "Tail paragraph here.")
    const shown = await revision(page)
    const from = (await pagePosts(page)).length
    // An ack for code the frame was never sent, as a page with a mistake in it would send.
    await frameOf(page).locator("body").evaluate((body, shown) => window.pagePort!.dispatchEvent(new MessageEvent("message", {
      data: { kind: "render-ack", session: shown.session, revision: shown.revision, slots: [], fluid: { epoch: 0, operation: 0, runtimeKey: "not-this-note", islands: [] } },
    })), shown)
    await expect.poll(() => page.evaluate(() => window.frameMessages.some((message) => message.kind === "render-request"))).toBe(true)
    await expect.poll(async () => (await pagePosts(page)).slice(from).some((post) => post.kind === "render" && post.doc && post.code)).toBe(true)
    await clickAt(page, "Tail paragraph here.", 19)
    await page.keyboard.type("xy")
    await expect.poll(() => source(page)).toBe("Lead paragraph here.\n\nTail paragraph herexy.\n")
    expect(await page.evaluate(() => window.renderedHarness.state().error)).toBeNull()
  })

  test("a frame that loads again gets the whole render on its new port, and typing goes on", async ({ page }) => {
    await openHarness(page)
    await load(page, "Lead paragraph here.\n\nTail paragraph here.\n", "mdx", "Tail paragraph here.")
    await clickAt(page, "Tail paragraph here.", 19)
    await page.keyboard.type("a")
    await expect.poll(() => source(page)).toBe("Lead paragraph here.\n\nTail paragraph herea.\n")
    await settled(page)
    // The frame's page loads again (as when a note's code navigates it): the
    // editor puts a new frame in its place, which has nothing yet.
    const before = await page.locator('iframe[title="Isolated document preview"]').elementHandle()
    await frameOf(page).locator("body").evaluate(() => location.reload())
    await expect.poll(() => page.locator('iframe[title="Isolated document preview"]').evaluate((element, before) => element !== before, before)).toBe(true)
    await expect(paragraph(page, "Tail paragraph herea.")).toBeVisible()
    await clickAt(page, "Tail paragraph herea.", 20)
    await page.keyboard.type("b")
    await expect.poll(() => source(page)).toBe("Lead paragraph here.\n\nTail paragraph hereab.\n")
    expect(await page.evaluate(() => window.frameMessages.filter((message) => message.kind === "render-request").length)).toBe(0)
  })

  test("a refused edit's notice shows over the bottom of the note, and showing it or taking it away moves nothing", async ({ page }) => {
    await openHarness(page)
    await load(page, "Before paragraph here.\n\n<Counter initial={3} />\n\nAfter paragraph here.\n", "mdx", "After paragraph here.")
    const editor = page.locator('iframe[title="Isolated document preview"]')
    const frameBox = await editor.boundingBox()
    const top = () => paragraph(page, "After paragraph here.").evaluate((element) => element.getBoundingClientRect().top)
    const first = await top()
    await clickAt(page, "Before paragraph here.", 3)
    await press(page, "ControlOrMeta+a")
    await press(page, "Backspace")
    const notice = page.getByRole("status").filter({ hasText: /^Edit not applied:/ })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText("This selection crosses computed output")
    expect(await editor.boundingBox()).toEqual(frameBox)
    expect(await top()).toBe(first)
    // It sits at the bottom of the editor, over the note, and lets clicks through.
    const box = (await notice.boundingBox())!
    expect(Math.abs(box.y + box.height - (frameBox!.y + frameBox!.height))).toBeLessThanOrEqual(1)
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('iframe[title="Isolated document preview"]'), { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(true)
    // The next edit the note takes clears it, as before.
    await clickAt(page, "Before paragraph here.", 3)
    await page.keyboard.type("x")
    await expect.poll(() => source(page)).toBe("Befxore paragraph here.\n\n<Counter initial={3} />\n\nAfter paragraph here.\n")
    await expect(notice).toHaveCount(0)
    expect(await editor.boundingBox()).toEqual(frameBox)
    expect(await top()).toBe(first)
  })

  test("Enter in a table cell keeps what was typed: the note has it, and typing goes on in the cell", async ({ page }) => {
    await openHarness(page)
    const note = "Intro.\n\n| A | B |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\nMore text.\n"
    await load(page, note, "mdx", "More text.")
    const cell = (row: number, column = 0) => frameOf(page).locator("tbody tr").nth(row).locator("td").nth(column).locator('[role="textbox"]')
    const end = async (row: number, column = 0) => {
      const box = (await cell(row, column).boundingBox())!
      await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
    }
    /** The frame shows the note's latest revision. */
    const shown = async () => expect.poll(async () => (await revision(page)).revision).toBe(await page.evaluate(() => window.renderedHarness.state().revision))
    await end(0)
    await page.keyboard.type("x")
    await page.keyboard.press("Enter")
    // Typed straight on, before the note has the cell: it goes on in the cell.
    await page.keyboard.type("y")
    await expect.poll(() => source(page)).toContain("| ax | 1 |")
    await expect(cell(0)).toBeFocused()
    await expect(cell(0)).toHaveText("axy")
    await page.keyboard.type("z")
    await page.keyboard.press("Enter")
    await expect.poll(() => source(page)).toBe(note.replace("| a |", "| axyz |"))
    await shown()
    // Enter with nothing new typed sends nothing, and the caret stays.
    await page.keyboard.press("Enter")
    await page.keyboard.type("w")
    await expect(cell(0)).toHaveText("axyzw")
    await page.keyboard.press("Enter")
    await expect.poll(() => source(page)).toBe(note.replace("| a |", "| axyzw |"))
    await shown()
    // Shift+Enter sends the cell as Enter does: a line break would end the
    // table's row, so the cell has none, and the table keeps its rows.
    await end(1, 1)
    await page.keyboard.type("9")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("8")
    await expect.poll(() => source(page)).toContain("| b | 29 |")
    await expect(cell(1, 1)).toHaveText("298")
    await page.keyboard.press("Enter")
    await expect.poll(() => source(page)).toBe(note.replace("| a |", "| axyzw |").replace("| b | 2 |", "| b | 298 |"))
    await expect(frameOf(page).locator("tbody tr")).toHaveCount(2)
    await expect(page.getByText(/^Edit not applied:/)).toHaveCount(0)
  })

  test("a line break a frame sends for a table cell is refused, and the note keeps its rows", async ({ page }) => {
    await openHarness(page)
    const note = "Intro.\n\n| A | B |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\nMore text.\n"
    await load(page, note, "mdx", "More text.")
    const shown = await revision(page)
    // Pasted, or sent by the note's own code: either way the page checks it.
    await frameOf(page).locator("tbody tr").first().locator("td").first().locator('[role="textbox"]').evaluate((element, shown) => {
      const { authoringFrom, authoringTo, authoringExpected } = (element as HTMLElement).dataset
      window.pagePort!.postMessage({ kind: "prose-edit", session: shown.session, revision: shown.revision, from: Number(authoringFrom), to: Number(authoringTo), expected: authoringExpected, value: "a\n| c | 3", shortcut: false, caret: 0 })
    }, shown)
    await expect(page.getByRole("status").filter({ hasText: /^Edit not applied:/ })).toBeVisible()
    expect(await source(page)).toBe(note)
    await expect(frameOf(page).locator("tbody tr")).toHaveCount(2)
  })

  test("a component's text the note refuses, with nothing else changed, can be sent again", async ({ page }) => {
    await openHarness(page)
    const note = `Intro.\n\n<Callout tone="info" title="A note">\nA note body\n</Callout>\n\nMore text.\n`
    await load(page, note, "mdx", "More text.")
    const body = frameOf(page).locator('[data-component="Callout"] [role="textbox"]').filter({ hasText: "A note body" })
    const end = async () => {
      const box = (await body.boundingBox())!
      await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
    }
    // The text's next edit names source the note does not have there, as a
    // stale or mistaken frame might, so the page refuses it and the note
    // stays as it is.
    await frameOf(page).locator("body").evaluate(() => {
      const port = window.pagePort!
      const send = port.postMessage.bind(port)
      port.postMessage = (message: unknown) => {
        const edit = message as { kind?: string; expected?: string }
        if (edit?.kind !== "prose-edit") return send(message)
        delete (port as { postMessage?: unknown }).postMessage
        send({ ...edit, expected: `${edit.expected}!` })
      }
    })
    await end()
    await page.keyboard.type(" one")
    await clickAt(page, "More text.", 2)
    await expect(page.getByRole("status").filter({ hasText: /^Edit not applied:/ })).toBeVisible()
    expect(await source(page)).toBe(note)
    // The text, which still shows what was typed, sends its next edit, which the note takes.
    await end()
    await page.keyboard.type(" two")
    await clickAt(page, "More text.", 2)
    await expect.poll(() => source(page)).toBe(note.replace("A note body", "A note body one two"))
  })

  test("equal islands start again when another like them comes before them, and none takes the count of another", async ({ page }) => {
    await openHarness(page)
    const note = (top: string) => `${top}Intro.\n\n<Counter initial={1} />\n\nText.\n\n<Counter initial={1} />\n`
    await load(page, note(""), "mdx", "Intro.")
    const frame = frameOf(page)
    const counts = frame.locator('[data-component="Counter"] output')
    await expect(counts).toHaveCount(2)
    const increment = frame.getByRole("button", { name: "Increment" })
    await increment.nth(0).click()
    await increment.nth(1).click()
    await increment.nth(1).click()
    await expect(counts).toHaveText(["2", "3"])
    // Typing between them keeps both.
    await clickAt(page, "Text.", 4)
    await page.keyboard.type(" more")
    await expect.poll(() => source(page)).toBe(note("").replace("Text.", "Text more."))
    await settled(page)
    await expect(counts).toHaveText(["2", "3"])
    // A third like them, first in the note (as Source or another device
    // writes it): an equal island's id is its place among them, so they
    // all start again rather than each showing the count of the one before.
    await page.evaluate((text) => window.renderedHarness.edit(text), note("<Counter initial={1} />\n\n").replace("Text.", "Text more."))
    await expect(counts).toHaveCount(3)
    await expect(counts).toHaveText(["1", "1", "1"])
  })

  test("a note's first paint keeps the box of each picture whose pixels are on their way", async ({ page }) => {
    // In each note frame, what the page sends, in order; and the pixels it
    // sends are held back until the test lets them through.
    await page.addInitScript(() => {
      if (window === window.top) return
      const held: unknown[] = []
      const said: string[] = []
      const state = { holding: true, port: null as MessagePort | null }
      Object.assign(window, {
        __said: said,
        __releaseImages: () => {
          state.holding = false
          for (const data of held.splice(0)) state.port?.dispatchEvent(new MessageEvent("message", { data }))
        },
      })
      window.addEventListener("message", (event) => {
        if (event.data?.kind !== "connect" || !event.ports[0]) return
        state.port = event.ports[0]
        state.port.addEventListener("message", (message) => {
          said.push(String(message.data?.kind))
          if (!state.holding || message.data?.kind !== "images") return
          message.stopImmediatePropagation()
          held.push(message.data)
        })
      })
    })
    await openHarness(page)
    // A 400 by 300 picture's pixels, which the editor has as it opens the note.
    const dataURL = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 400
      canvas.height = 300
      const context = canvas.getContext("2d")!
      context.fillStyle = "#c33"
      context.fillRect(0, 0, 400, 300)
      return canvas.toDataURL("image/png")
    })
    await page.evaluate((dataURL) => window.renderedHarness.load("# Pictures\n\nAnchor paragraph.\n\n![A picture](pic.png)\n\nAfter paragraph.\n", "md", { "pic.png": { dataURL, width: 400, height: 300 } }), dataURL)
    const after = paragraph(page, "After paragraph.")
    await after.waitFor()
    const frame = frameOf(page)
    await expect(frame.locator(".project-image-missing")).toBeVisible()
    // Nothing about the note came before its render, which the frame would not have taken.
    const said = await frame.locator("body").evaluate(() => (window as unknown as { __said: string[] }).__said)
    expect(said.slice(0, said.indexOf("render"))).toEqual(["appearance", "reading-preferences"])
    const before = await after.evaluate((element) => element.getBoundingClientRect().top)
    await frame.locator("body").evaluate(() => (window as unknown as { __releaseImages: () => void }).__releaseImages())
    await expect(frame.locator(".project-image-open img")).toHaveJSProperty("naturalWidth", 400)
    expect(Math.abs((await after.evaluate((element) => element.getBoundingClientRect().top)) - before)).toBeLessThanOrEqual(1)
  })

  test("typing before an open embedded document sends nothing about it, either way", async ({ page }) => {
    await openHarness(page)
    await page.evaluate(() => window.renderedHarness.setEmbeddedDocuments({ "notes/details.md": "# Details\n\nChild paragraph one.\n" }))
    await load(page, 'Intro paragraph.\n\n<Document src="notes/details.md" title="Details" />\n\nClosing paragraph.\n', "mdx", "Intro paragraph.")
    const frame = frameOf(page)
    await expect(frame.frameLocator('iframe[title^="Embedded document"]').getByText("Child paragraph one.")).toBeVisible({ timeout: 20_000 })
    await clickAt(page, "Intro paragraph.", 15)
    await settled(page)
    // From here on, what the page sends the note's frame, and what it sends the page.
    await frame.locator("body").evaluate(() => {
      const kinds: string[] = []
      Object.assign(window, { __toFrame: kinds })
      window.pagePort!.addEventListener("message", (event) => kinds.push(String(event.data?.kind)))
    })
    const from = await page.evaluate(() => window.frameMessages.length)
    for (const key of "abcdef") {
      await page.keyboard.type(key)
      await page.waitForTimeout(80)
    }
    await expect.poll(() => source(page)).toContain("Intro paragraphabcdef.")
    await settled(page)
    await page.waitForTimeout(300)
    const toPage = await page.evaluate((from) => window.frameMessages.slice(from).map((message) => message.kind), from)
    const toFrame = await frame.locator("body").evaluate(() => (window as unknown as { __toFrame: string[] }).__toFrame)
    expect(toPage.filter((kind) => kind.startsWith("document-embed"))).toEqual([])
    expect(toFrame.filter((kind) => kind.startsWith("document-embed"))).toEqual([])
    await expect(frame.frameLocator('iframe[title^="Embedded document"]').getByText("Child paragraph one.")).toBeVisible()
  })

  test("a frame that says it is ready in the middle of showing a new revision still has its palette before the note", async ({ page }) => {
    // The note frame's own ready is held back, and the page is given it in
    // the middle of the commit that shows the note's next revision (now and
    // then React commits once more between them): the render that commit
    // posts is the first thing on the frame's new port unless the palette
    // went first, when the port was made.
    await page.addInitScript(() => {
      if (window !== window.top) {
        const said: string[] = []
        Object.assign(window, { __said: said })
        window.addEventListener("message", (event) => {
          if (event.data?.kind === "connect") event.ports[0]?.addEventListener("message", (message) => said.push(`${message.data?.kind}:${message.data?.revision ?? ""}`))
        })
        return
      }
      const ready = { holding: false, held: null as MessageEvent | null, projected: false }
      Object.assign(window, { __ready: ready })
      window.addEventListener("rendered-harness-error", (event) => {
        if (ready.holding && (event as CustomEvent).detail === null) ready.projected = true
      })
      window.addEventListener("message", (event) => {
        if (!ready.holding || event.data?.kind !== "ready" || ready.held) return
        event.stopImmediatePropagation()
        ready.held = event
      }, true)
    })
    await openHarness(page)
    await page.evaluate(() => {
      ;(window as unknown as { __ready: { holding: boolean } }).__ready.holding = true
      window.renderedHarness.load("Lead paragraph here.\n\nTail paragraph here.\n", "md")
    })
    // The frame has said it is ready, and the editor has the note's first projection.
    await page.waitForFunction(() => {
      const ready = (window as unknown as { __ready: { held: unknown; projected: boolean } }).__ready
      return ready.held !== null && ready.projected
    })
    await page.evaluate(() => {
      const ready = (window as unknown as { __ready: { held: MessageEvent } }).__ready
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Isolated document preview"]')!
      const read = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow")!.get!
      // The editor says its projection of the edit worked just before the
      // commit that shows it, and reads its frame's window in a layout
      // effect of every commit.
      let projected = false
      window.addEventListener("rendered-harness-error", (event) => {
        if ((event as CustomEvent).detail === null) projected = true
      }, { once: true })
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        get() {
          if (projected) {
            delete (iframe as { contentWindow?: unknown }).contentWindow
            // The frame's ready, from the frame's window. Firefox takes no
            // window of another origin for a new event, and dispatches the
            // frame's own event again instead (Chromium keeps it stopped).
            let event: MessageEvent
            try {
              event = new MessageEvent("message", { data: ready.held.data, source: ready.held.source })
            } catch {
              event = ready.held
            }
            window.dispatchEvent(event)
          }
          return read.call(this)
        },
      })
      window.renderedHarness.edit("Lead paragraph here, edited.\n\nTail paragraph here.\n")
    })
    await paragraph(page, "Lead paragraph here, edited.").waitFor()
    const edited = await page.evaluate(() => window.renderedHarness.state().revision)
    const said = await frameOf(page).locator("body").evaluate(() => (window as unknown as { __said: string[] }).__said)
    // The palette and reading preferences first, then the note: before
    // them, the render that commit posted was the first thing the frame had.
    expect(said.slice(0, 2)).toEqual(["appearance:", "reading-preferences:"])
    expect(said).toContain(`render:${edited}`)
  })

  test("a cell edit the note refuses shows the note's text again, and the cell can be edited again", async ({ page }) => {
    await openHarness(page)
    const note = (intro: string, cell: string) => `${intro}\n\n| A | B |\n| --- | --- |\n| ${cell} | 1 |\n\nMore text.\n`
    await load(page, note("Intro.", "a"), "mdx", "More text.")
    // The cell's edit is held back in the frame while the note changes.
    await frameOf(page).locator("body").evaluate(() => {
      const port = window.pagePort!
      const send = port.postMessage.bind(port)
      const held: unknown[] = []
      Object.assign(window, { __release: () => { for (const message of held.splice(0)) send(message) } })
      port.postMessage = (message: unknown) => {
        if ((message as { kind?: string } | null)?.kind === "prose-edit") held.push(message)
        else send(message)
      }
    })
    const cell = frameOf(page).locator("tbody tr").first().locator("td").first().locator('[role="textbox"]')
    const end = async () => {
      const box = (await cell.boundingBox())!
      await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2)
    }
    await end()
    await page.keyboard.type("x")
    await clickAt(page, "More text.", 2)
    await page.evaluate((text) => window.renderedHarness.edit(text), note("Intro text.", "a"))
    await expect(paragraph(page, "Intro text.")).toBeVisible()
    await frameOf(page).locator("body").evaluate(() => (window as unknown as { __release: () => void }).__release())
    // Refused: the note changed under it. The cell shows the note's text again.
    await expect(page.getByRole("status").filter({ hasText: /^Edit not applied:/ })).toBeVisible()
    await expect(cell).toHaveText("a")
    expect(await source(page)).toBe(note("Intro text.", "a"))
    // And it sends its next edit, which the note takes.
    await frameOf(page).locator("body").evaluate(() => {
      delete (window.pagePort as { postMessage?: unknown }).postMessage
    })
    await end()
    await page.keyboard.type("y")
    await clickAt(page, "More text.", 2)
    await expect.poll(() => source(page)).toBe(note("Intro text.", "ay"))
  })
})

test.describe("in the app", () => {
  test.use({ viewport: { width: 1280, height: 900 } })
  test.describe.configure({ timeout: 60_000 })
  const FRAME = 'iframe[title="Isolated document preview"]:visible'
  const frame = (page: Page) => page.frameLocator(FRAME)
  const lines = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
  /** From the next load on, count by kind what the page sends its frames. */
  const countPosts = (page: Page) =>
    page.addInitScript(() => {
      if (window !== window.top) return
      const posts: Record<string, number> = {}
      Object.assign(window, { __posts: posts })
      const post = MessagePort.prototype.postMessage
      MessagePort.prototype.postMessage = function (this: MessagePort, ...args: Parameters<MessagePort["postMessage"]>) {
        const kind = (args[0] as { kind?: unknown } | null)?.kind
        if (typeof kind === "string") posts[kind] = (posts[kind] ?? 0) + 1
        return post.apply(this, args)
      } as MessagePort["postMessage"]
    })
  const posts = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __posts: Record<string, number> }).__posts }))
  const forgetPosts = (page: Page) => page.evaluate(() => {
    const counts = (window as unknown as { __posts: Record<string, number> }).__posts
    for (const kind of Object.keys(counts)) delete counts[kind]
  })

  test("typing after an image keeps the same picture on screen, and nothing below it moves", async ({ page }) => {
    await recordFrameMessages(page)
    await countPosts(page)
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
    await forgetPosts(page)
    for (const key of "typed") {
      await page.keyboard.type(key)
      await page.waitForTimeout(60)
    }
    await expect(after).toContainText("typed")
    await page.waitForTimeout(500)
    // Each keystroke's answer is all the frame was sent: its pixels were not sent again.
    expect(Object.keys(await posts(page))).toEqual(["render-ack"])

    expect(await kept(image)).toBe(true)
    expect(await frame(page).locator("body").evaluate(() => (window as Window & { __imageChanges?: object }).__imageChanges)).toEqual({ placeholders: 0, removed: 0 })
    expect(Math.abs((await after.evaluate((element) => element.getBoundingClientRect().top)) - before)).toBeLessThanOrEqual(1)
  })

  test("typing in a note with a commented phrase sends the frame each edit's answer only, and the phrase stays marked", async ({ page }) => {
    await countPosts(page)
    await recordFrameMessages(page)
    const note = "# Customer model\n\nHow a customer moves from sign-up to their first project, and where agents help.\n\nLast paragraph here.\n"
    const server = new FakeProjectServer()
    const id = crypto.randomUUID()
    await server.remote(person.id).createProject(id, "Notes")
    // Files the note can embed, which the frame lists for Insert block.
    await server.remote(person.id).saveFiles(id, crypto.randomUUID(), [
      { op: "put", path: "a.md", content: note },
      { op: "put", path: "sketch.excalidraw", content: '{"type":"excalidraw","version":2,"elements":[]}' },
      { op: "put", path: "flow.d2", content: "a -> b" },
    ])
    const fake = await fakeSupabase(page, { server })
    const fileId = [...fake.server.projects.get(id)!.files.values()].find((file) => file.path === "a.md")!.id
    const quote = note.indexOf("where agents help")
    fake.comments.call(person.id, "add_comment", { project_id: id, thread_id: crypto.randomUUID(), file_id: fileId, file_version: 1, anchor: textAnchor(note, quote, quote + "where agents help".length), body: "Which agents?" })
    await signedIn(page)
    await page.goto(new URL(`projects/${id}/a.md`, APP_URL).href)
    await expect(page.getByRole("tabpanel", { name: "a.md" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Rendered", exact: true }).click()
    const marked = frame(page).locator(".comment-highlight")
    await expect(marked).toHaveText(["where agents help"])
    await frame(page).getByText("Last paragraph here.", { exact: true }).click()
    await page.keyboard.press("End")
    await page.keyboard.type(" ")
    await expect(frame(page).getByText("Last paragraph here.", { exact: false })).toBeVisible()
    await page.waitForTimeout(500)
    await forgetPosts(page)
    await page.keyboard.type("abcdefgh", { delay: 100 })
    await expect(frame(page).getByText("Last paragraph here. abcdefgh", { exact: true })).toBeVisible()
    await page.waitForTimeout(800)
    // The palette, the reading preferences, the paths and the marks were not sent again.
    const sent = await posts(page)
    expect(Object.keys(sent)).toEqual(["render-ack"])
    expect(sent["render-ack"]).toBeLessThanOrEqual(8)
    await expect(marked).toHaveText(["where agents help"])
    // Words typed before the phrase move its mark: the marks go, and it stays on its words.
    await frame(page).getByText(/^How a customer moves/).click({ position: { x: 1, y: 8 } })
    await page.keyboard.type("Today, ")
    await expect(frame(page).getByText(/^Today, How a customer moves/)).toBeVisible()
    await expect(marked).toHaveText(["where agents help"])
  })

  test("a commented phrase's marker stays beside its line when typing elsewhere leaves the marks as they were and the note scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    const lead = Array.from({ length: 4 }, (_, index) => `Opening paragraph ${index + 1} of the note.`).join("\n\n")
    const tail = Array.from({ length: 30 }, (_, index) => `Later paragraph ${index + 1} of the note.`).join("\n\n")
    const note = `# Customer model\n\n${lead}\n\nHow a customer moves from sign-up to their first project, and where agents help.\n\n${tail}\n`
    const server = new FakeProjectServer()
    const id = crypto.randomUUID()
    await server.remote(person.id).createProject(id, "Notes")
    await server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.md", content: note }])
    const fake = await fakeSupabase(page, { server })
    const fileId = [...fake.server.projects.get(id)!.files.values()].find((file) => file.path === "a.md")!.id
    const quote = note.indexOf("where agents help")
    fake.comments.call(person.id, "add_comment", { project_id: id, thread_id: crypto.randomUUID(), file_id: fileId, file_version: 1, anchor: textAnchor(note, quote, quote + "where agents help".length), body: "Which agents?" })
    await signedIn(page)
    await page.goto(new URL(`projects/${id}/a.md`, APP_URL).href)
    await expect(page.getByRole("tabpanel", { name: "a.md" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Rendered", exact: true }).click()
    await expect(frame(page).locator(".comment-highlight")).toHaveText(["where agents help"])
    // How far the marker's middle is from the marked words' middle, in the page.
    const marker = page.getByRole("button", { name: "1 thread on this line", exact: true })
    const apart = async () => {
      const box = (await page.locator(FRAME).boundingBox())!
      const words = await frame(page).locator(".comment-highlight").evaluate((span) => span.getClientRects()[0].toJSON() as DOMRect)
      const beside = (await marker.boundingBox())!
      return Math.abs(beside.y + beside.height / 2 - (box.y + words.y + words.height / 2))
    }
    await expect.poll(apart).toBeLessThan(3)
    // Typed after the phrase, which keeps every mark where it was.
    await frame(page).getByText("Later paragraph 2 of the note.", { exact: true }).click()
    await page.keyboard.type("x")
    await expect.poll(async () => (await frame(page).locator("p").filter({ hasText: /^Later paragraph 2 of the note/ }).textContent())?.includes("x")).toBe(true)
    await page.waitForTimeout(300)
    await frame(page).locator("body").evaluate(() => document.scrollingElement!.scrollBy(0, 120))
    await expect.poll(apart).toBeLessThan(3)
  })

  test("a newer saved version of an open note with components keeps the note on screen while they are made again", async ({ page }) => {
    const before = "# Note\n\nFirst paragraph here.\n\n<Counter initial={1} />\n\nLast paragraph here.\n"
    const fake = await fakeSupabase(page)
    const remote = fake.server.remote(person.id)
    const id = crypto.randomUUID()
    await remote.createProject(id, "Notes")
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.mdx", content: before }])
    await signedIn(page)
    await page.goto(new URL(`projects/${id}/a.mdx`, APP_URL).href)
    await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Rendered", exact: true }).click()
    await expect(frame(page).getByText("Last paragraph here.")).toBeVisible()
    await frame(page).getByRole("button", { name: "Increment" }).click()
    await expect(frame(page).locator('[data-component="Counter"] output')).toHaveText("2")
    // Where the frame is and how tall, at every frame from now on.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as Window & { __frameBoxes?: string[] }).__frameBoxes = seen
      const sample = () => {
        const element = [...document.querySelectorAll('iframe[title="Isolated document preview"]')].find((frame) => frame.getBoundingClientRect().height > 0) as HTMLIFrameElement | undefined
        const box = element?.getBoundingClientRect()
        const line = box ? `${Math.round(box.top)}:${Math.round(box.height)}` : "none"
        if (seen.at(-1) !== line) seen.push(line)
        if (seen.length < 50) requestAnimationFrame(sample)
      }
      sample()
    })
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "a.mdx", content: `${before}\nA paragraph another device added.\n`, base_version: 1 }])
    fake.signal(id, fake.server.projects.get(id)!.revision)
    await expect(frame(page).getByText("A paragraph another device added.")).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as Window & { __frameBoxes?: string[] }).__frameBoxes)).toHaveLength(1)
    await expect(frame(page).locator('[data-component="Counter"] output')).toHaveText("2")
  })
})

import { expect, type Page } from "@playwright/test"
import { HARNESS_URL } from "./urls.ts"

// Helpers for journeys on the rendered-note harness page. They observe the
// page and the frame (text, selection, messages); every edit is real mouse
// and keyboard input.

export const RENDERED_URL = new URL("rendered.html", HARNESS_URL).href
const FRAME = 'iframe[title="Isolated document preview"]'

type FrameMessage = { kind: string; session?: string; revision?: number; pending?: boolean }
export type Revision = { session: string; revision: number }

declare global {
  interface Window {
    frameMessages: FrameMessage[]
    /** When enabled, the frame's edit transactions are held back from the editor. */
    transactionGate: { enabled: boolean; held: MessageEvent[] }
  }
}

export const frameOf = (page: Page) => page.frameLocator(FRAME)
export const source = (page: Page) => page.evaluate(() => window.renderedHarness.source())
export const paragraph = (page: Page, text: string | RegExp) => frameOf(page).locator("p").filter({ hasText: text }).first()

/** Open the harness and record every message the frame sends the page. */
export async function openHarness(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.frameMessages = []
    // Registered before any app code, so it runs before the editor's listener.
    window.transactionGate = { enabled: false, held: [] }
    window.addEventListener(
      "message",
      (event) => {
        if (!window.transactionGate.enabled || event.data?.kind !== "fluid-transaction") return
        event.stopImmediatePropagation()
        window.transactionGate.held.push(event)
      },
      true,
    )
    window.addEventListener("message", (event) => {
      if (![...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === event.source)) return
      const data = event.data
      if (data && typeof data.kind === "string") {
        window.frameMessages.push({ kind: data.kind, session: data.session, revision: data.revision, pending: data.pending })
      }
    })
  })
  await page.goto(RENDERED_URL)
  return errors
}

/** Load a note and wait until the frame has rendered it. */
export async function load(page: Page, text: string, format: "md" | "mdx", visible: string | RegExp): Promise<Revision> {
  await page.evaluate(([text, format]) => window.renderedHarness.load(text, format as "md" | "mdx"), [text, format])
  await paragraph(page, visible).waitFor()
  return revision(page)
}

/** The latest revision the frame acknowledged as rendered. */
export async function revision(page: Page): Promise<Revision> {
  await page.waitForFunction(() => window.frameMessages.some((message) => message.kind === "rendered"))
  return page.evaluate(() => window.frameMessages.filter((message) => message.kind === "rendered").at(-1) as Revision)
}

/** Wait for the frame to acknowledge a revision newer than `mark` in the same session. */
export async function accepted(page: Page, mark: Revision) {
  await page.waitForFunction(
    (mark) => window.frameMessages.some((message) => message.kind === "rendered" && message.session === mark.session && message.revision! > mark.revision),
    mark,
    { timeout: 4_000 },
  )
}

/** Wait until the frame reports that no edit is pending. */
export async function settled(page: Page) {
  await page.waitForFunction(() => window.frameMessages.filter((message) => message.kind === "fluid-pending").at(-1)?.pending === false)
}

/** Page coordinates of a visible character in a frame paragraph (measured, never set). */
export async function point(page: Page, text: string, offset: number) {
  const target = paragraph(page, text)
  await target.scrollIntoViewIfNeeded()
  const local = await target.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = offset
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining < length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.setEnd(node, remaining + 1)
        const box = range.getBoundingClientRect()
        // A quarter into the glyph: Firefox misplaces a click right at the
        // edge of text next to generated content, such as inline code's
        // decorative backticks.
        return { x: box.x + box.width / 4, y: box.y + box.height / 2 }
      }
      remaining -= length
    }
    throw new Error("That character is not in the paragraph")
  }, offset)
  const frame = await page.locator(FRAME).boundingBox()
  return { x: frame!.x + local.x, y: frame!.y + local.y }
}

/**
 * Wait for the frame's next animation frame. Keys and clicks sent faster
 * than a person can press them can be lost in Chromium (task T10), so the
 * helpers below pause this long after each one.
 */
export async function nextFrame(page: Page) {
  await frameOf(page)
    .locator("body")
    .evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))))
}

export async function clickAt(page: Page, text: string, offset: number) {
  const at = await point(page, text, offset)
  await page.mouse.click(at.x, at.y)
  await nextFrame(page)
}

export async function press(page: Page, key: string, count = 1) {
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(key)
    await nextFrame(page)
  }
}

/** The frame's selection: its text and where each end is, as paragraph text and offset. */
export async function selection(page: Page) {
  return frameOf(page)
    .locator("body")
    .evaluate(() => {
      const current = window.getSelection()
      const position = (node: Node | null | undefined, offset: number | undefined) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement
        const p = element?.closest("p")
        if (!p || !node || offset === undefined) return null
        const range = document.createRange()
        range.selectNodeContents(p)
        range.setEnd(node, offset)
        return { paragraph: p.textContent, offset: range.toString().length }
      }
      return {
        text: current?.toString(),
        collapsed: current?.isCollapsed,
        focused: document.hasFocus(),
        anchor: position(current?.anchorNode, current?.anchorOffset),
        focus: position(current?.focusNode, current?.focusOffset),
      }
    })
}

/** Deliver the held transactions, as they were sent, and stop holding. */
export async function releaseTransactions(page: Page) {
  return page.evaluate(() => {
    window.transactionGate.enabled = false
    const held = window.transactionGate.held.splice(0)
    for (const event of held) {
      // Chromium ignores an event dispatched a second time, so send a copy;
      // Firefox cannot copy one whose source is an opaque frame, so it gets
      // the original again.
      let copy: MessageEvent | null = null
      try {
        copy = new MessageEvent("message", { data: event.data, origin: event.origin, source: event.source })
      } catch {
        copy = null
      }
      window.dispatchEvent(copy ?? event)
    }
    return held.length
  })
}

export function expectNoErrors(errors: string[]) {
  expect(errors).toEqual([])
}

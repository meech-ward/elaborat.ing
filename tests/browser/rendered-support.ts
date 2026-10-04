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
    transactionGate: { enabled: boolean; held: { port: MessagePort; data: unknown }[] }
    /** In the frame: the port the page gave it, to hear what the page sends. */
    pagePort?: MessagePort
  }
}

export const frameOf = (page: Page) => page.frameLocator(FRAME)
export const source = (page: Page) => page.evaluate(() => window.renderedHarness.source())
export const paragraph = (page: Page, text: string | RegExp) => frameOf(page).locator("p").filter({ hasText: text }).first()

/** Open the harness (with `query`, such as `?sandbox=<origin>`) and record every message the frame sends the page. */
export async function openHarness(page: Page, query = ""): Promise<string[]> {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.frameMessages = []
    window.transactionGate = { enabled: false, held: [] }
    // The frame speaks on the port the editor gives it: listen on every
    // channel the page makes, ahead of the editor, which listens after.
    const Channel = window.MessageChannel
    window.MessageChannel = class extends Channel {
      constructor() {
        super()
        const port = this.port1
        port.addEventListener("message", (event) => {
          const data = event.data
          if (window.transactionGate.enabled && data?.kind === "fluid-transaction") {
            event.stopImmediatePropagation()
            window.transactionGate.held.push({ port, data })
            return
          }
          if (data && typeof data.kind === "string") {
            window.frameMessages.push({ kind: data.kind, session: data.session, revision: data.revision, pending: data.pending })
          }
        })
      }
    }
    // In the frame: keep the port the page gives it.
    window.addEventListener("message", (event) => {
      if (event.data?.kind === "connect" && event.ports[0]) window.pagePort = event.ports[0]
    })
  })
  await page.goto(`${RENDERED_URL}${query}`)
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

export async function clickAt(page: Page, text: string, offset: number) {
  const at = await point(page, text, offset)
  await page.mouse.click(at.x, at.y)
}

export async function press(page: Page, key: string, count = 1) {
  for (let i = 0; i < count; i++) await page.keyboard.press(key)
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
    for (const { port, data } of held) port.dispatchEvent(new MessageEvent("message", { data }))
    return held.length
  })
}

export function expectNoErrors(errors: string[]) {
  expect(errors).toEqual([])
}

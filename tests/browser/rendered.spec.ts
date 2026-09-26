import { readFile } from "node:fs/promises"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { HARNESS_URL } from "./urls.ts"

// The rendered editor on the harness page: the note is evaluated only inside
// the sandboxed frame, and typing in the frame changes exactly the source
// text it shows.

// Playwright's service worker blocking (playwright.config.ts) runs a script in
// every frame, which throws inside the sandboxed preview frame. The harness
// registers no worker, so these tests leave workers allowed.
test.use({ serviceWorkers: "allow" })

const RENDERED = new URL("rendered.html", HARNESS_URL).href
const frameOf = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]')
const source = (page: Page) => page.evaluate(() => window.renderedHarness.source())

async function open(page: Page, text: string, format: "md" | "mdx", errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(RENDERED)
  await page.evaluate(([text, format]) => window.renderedHarness.load(text, format as "md" | "mdx"), [text, format])
}

/** Click just after the last character of a paragraph inside the frame. */
async function clickEnd(page: Page, text: string) {
  const paragraph = frameOf(page).locator("p").filter({ hasText: text }).first()
  await paragraph.waitFor()
  const box = await paragraph.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const rects = range.getClientRects()
    const last = rects[rects.length - 1]
    return { x: last.right - 1, y: last.top + last.height / 2 }
  })
  const frame = await page.locator('iframe[title="Isolated document preview"]').boundingBox()
  await page.mouse.click(frame!.x + box.x, frame!.y + box.y)
}

test("typing in a rendered paragraph changes exactly that text in the source", async ({ page }) => {
  const errors: string[] = []
  const original = "# A note\n\nHello world.\n\nLeft *alone* here.\n"
  await open(page, original, "md", errors)
  await clickEnd(page, "Hello world.")
  await page.keyboard.type(" More words")
  await expect.poll(() => source(page)).toBe("# A note\n\nHello world. More words\n\nLeft *alone* here.\n")
  expect(errors).toEqual([])
})

test("MDX components run inside the frame, and the frame loads nothing", async ({ page }) => {
  const errors: string[] = []
  const requests: string[] = []
  page.on("request", (request) => requests.push(request.url()))
  await open(page, "export const start = 3\n\n# Counter\n\n<Counter initial={start} />\n\nAfter the counter.\n", "mdx", errors)
  const frame = frameOf(page)
  await expect(frame.getByRole("heading", { name: "Counter" })).toBeVisible()
  const count = frame.locator('[data-component="Counter"] output')
  await expect(count).toHaveText("3")
  const before = requests.length
  await frame.getByRole("button", { name: "Increment" }).click()
  await expect(count).toHaveText("4")
  expect(requests.slice(before)).toEqual([])
  expect(await source(page)).toContain("<Counter initial={start} />")
  expect(errors).toEqual([])
})

test("a syntax error keeps the last good render and the source unchanged", async ({ page }) => {
  const errors: string[] = []
  await open(page, "# Fine\n\nGood text.\n", "mdx", errors)
  await expect(frameOf(page).getByText("Good text.")).toBeVisible()
  await page.evaluate(() => window.renderedHarness.load("# Broken\n\n<Unclosed\n", "mdx"))
  await expect(page.getByRole("alert")).toContainText("Source is unchanged")
  expect(await source(page)).toBe("# Broken\n\n<Unclosed\n")
})

test("the harness build lists the frame's packages in its license notices", async () => {
  const notices = await readFile(path.join(import.meta.dirname, "harness", "dist", "third-party-notices.txt"), "utf8")
  for (const name of ["prosemirror-view", "prosemirror-state", "react-dom"]) expect(notices).toMatch(new RegExp(`^## ${name} - `, "m"))
})

import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// On a touch screen, starting to scroll over a rendered note must not focus
// the prose (that would open the keyboard and jump the page), while a
// completed tap focuses the tapped paragraph. A mouse click focuses as before.
// The scroll runs in Chromium and the tap in Firefox; each test says why.

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/long.md"
const line = (n: number) => `Paragraph ${n} of a long note, with enough words in it to wrap on a phone.`
const NOTE = `# A long note\n\n${Array.from({ length: 60 }, (_, index) => line(index + 1)).join("\n\n")}\n`

const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const frameOf = (page: Page) => page.frameLocator(FRAME)
// The open file's panel, in the desktop and phone layouts alike.
const panel = (page: Page) => page.getByRole("tabpanel", { name: PATH })
const unsaved = (page: Page) => panel(page).getByText("Unsaved changes", { exact: true })
const saves = (fake: FakeSupabase) => fake.requests.filter((request) => request.url().endsWith("/rpc/save_files")).length

async function openNote(page: Page) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await expect(panel(page)).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect(frameOf(page).locator("p").filter({ hasText: line(60) })).toBeAttached()
  return { fake, id }
}

/** How far the rendered note is scrolled. */
const scrollTop = (page: Page) => frameOf(page).locator(":root").evaluate(() => document.scrollingElement!.scrollTop)

/** Whether editable prose in the frame has focus. */
const proseFocused = (page: Page) =>
  frameOf(page).locator(":root").evaluate(() => document.hasFocus() && document.activeElement?.closest('[contenteditable="true"]') != null)

async function save(page: Page) {
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Save" }).or(page.getByRole("button", { name: "Save" })).first().click()
}

/** The middle of paragraph `n` in the frame, in page coordinates. */
async function middleOf(page: Page, n: number) {
  const paragraph = frameOf(page).locator("p").nth(n - 1)
  await expect(paragraph).toHaveText(line(n))
  const box = (await paragraph.boundingBox())!
  return { paragraph, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("a touch scroll over the rendered text scrolls it and leaves the editor unfocused", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Trusted touch moves are sent through the Chrome DevTools Protocol, which only Chromium has.")
    const { fake, id } = await openNote(page)
    const saved = saves(fake)
    // Put a finger down on the text near the bottom of the frame and drag it up.
    const frame = (await page.locator(FRAME).boundingBox())!
    const x = frame.x + frame.width / 2
    const from = frame.y + frame.height * 0.8
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] })
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from - step * 30 }] })
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })

    await expect.poll(() => scrollTop(page)).toBeGreaterThan(100)
    await page.waitForTimeout(300)
    expect(await proseFocused(page)).toBe(false)
    await expect(unsaved(page)).toHaveCount(0)
    await quiet(fake)
    expect(saves(fake)).toBe(saved)
    expect(fake.server.content(id, PATH)).toBe(NOTE)
  })

  test("a tap on a paragraph focuses it, and typing there saves only that change", async ({ page, browserName }) => {
    // Chromium runs the sandboxed preview frame in its own process. For a tap
    // sent through the DevTools Protocol into such a frame, it delivers the
    // touch and pointer events at the tapped point but the mouse events and
    // click too high by the frame's offset in the page, so the browser puts
    // the caret in the paragraph above. A plain page with a sandboxed frame
    // shows the same, so this is not the app.
    test.skip(browserName === "chromium", "Chromium sends a DevTools tap's mouse events to the wrong point in an out-of-process frame.")
    const { fake, id } = await openNote(page)
    const { paragraph, x, y } = await middleOf(page, 5)
    await page.touchscreen.tap(x, y)
    await expect.poll(() => proseFocused(page)).toBe(true)
    await page.keyboard.type("XYZ")
    await expect(paragraph).toContainText("XYZ")

    await save(page)
    await expect(unsaved(page)).toHaveCount(0)
    await expect.poll(() => fake.server.content(id, PATH)).not.toBe(NOTE)
    // Every other byte is as it was: the typing sits inside paragraph 5.
    const content = fake.server.content(id, PATH)!
    expect(content.replace("XYZ", "")).toBe(NOTE)
    const start = NOTE.indexOf(line(5))
    expect(content.indexOf("XYZ")).toBeGreaterThanOrEqual(start)
    expect(content.indexOf("XYZ")).toBeLessThanOrEqual(start + line(5).length)
  })
})

test("a mouse click on a paragraph focuses it, and typing lands there", async ({ page }) => {
  await openNote(page)
  const { paragraph } = await middleOf(page, 5)
  await paragraph.click()
  await expect.poll(() => proseFocused(page)).toBe(true)
  await page.keyboard.type("XYZ")
  await expect(paragraph).toContainText("XYZ")
})

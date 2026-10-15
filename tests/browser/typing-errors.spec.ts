import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// While the person types a tag into a note, it does not compile until the tag
// closes. No error shows while they type, and the rendered view keeps its last
// good render; text left unable to compile says so once they pause, after a
// second, or at once when they act on it, as Canvas or Save does for a drawing
// (src/lib/settledError.ts). The page notes the times itself, so a slow machine
// cannot blur them.

test.describe.configure({ timeout: 60_000 })
test.use({ viewport: { width: 1280, height: 800 } })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/typing.mdx"
const NOTE = "# Typing\n\nFirst paragraph here.\n"
const SHOWN = "Source is unchanged and remains editable."

const DRAWING_PATH = "sketch.excalidraw"
const DRAWING = '{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}'
const NOT_A_DRAWING = "This is not a valid drawing"

const projectUrl = (id: string, path: string) => new URL(`projects/${id}/${path}`, APP_URL).href
const paragraph = (page: Page, text: string) => page.frameLocator(FRAME).locator("p").filter({ hasText: text })
const sourceText = (page: Page) => page.locator(".monaco-editor:visible .view-lines")
const errorShown = (page: Page) => page.getByRole("alert").filter({ hasText: SHOWN })
const drawingView = (page: Page, name: string) => page.getByRole("group", { name: "Drawing view" }).getByRole("button", { name, exact: true })

type Times = { keyAt: number; errorAt: number | null; frameHiddenAt: number[] }
const times = (page: Page) => page.evaluate(() => (window as unknown as { typingTimes: Times }).typingTimes)

/** From now on the page notes its last key, when an error first shows, and whenever the rendered view is hidden. */
async function noteTimes(page: Page) {
  await page.evaluate(([frame, shown]) => {
    const noted: Times = { keyAt: 0, errorAt: null, frameHiddenAt: [] }
    Object.assign(window, { typingTimes: noted })
    document.addEventListener("keydown", () => void (noted.keyAt = performance.now()), true)
    new MutationObserver(() => {
      const now = performance.now()
      if (noted.errorAt === null && [...document.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes(shown))) noted.errorAt = now
      const holder = document.querySelector(frame)?.parentElement
      if (holder && getComputedStyle(holder).display === "none") noted.frameHiddenAt.push(now)
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] })
  }, [FRAME, SHOWN] as const)
}

test("typing through text that does not compile shows no error, and text left that way shows its error once the typing pauses", async ({ page, appErrors }) => {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  await fake.server.remote(person.id).createProject(id, "Notes")
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Split", exact: true }).click()
  await expect(paragraph(page, "First paragraph")).toBeVisible()
  await noteTimes(page)

  // Each key from "<" to the closing ">" leaves the note unable to compile.
  await sourceText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Some <b>bold</b> words.")
  await expect(paragraph(page, "Some bold words.").locator("b")).toHaveText("bold")
  // Nothing showed an error at any moment of it, and the rendered view stayed on screen.
  expect(appErrors.unexpected()).toEqual([])
  expect((await times(page)).frameHiddenAt).toEqual([])

  // Left unfinished, a tag's error shows once the typing has paused for a
  // second. (The text ends on a letter: a typed ">" only steps over the one
  // the editor closed the tag with, which changes nothing.)
  appErrors.expect(/Expected a closing tag/)
  await page.keyboard.type(" More <i>m")
  await expect(errorShown(page)).toBeVisible()
  const { keyAt, errorAt, frameHiddenAt } = await times(page)
  expect(errorAt! - keyAt).toBeGreaterThanOrEqual(950)
  // The rendered view kept its last good render until then.
  expect(frameHiddenAt.every((at) => at >= errorAt!)).toBe(true)

  // Fixed, the error goes at once and the note renders again.
  await page.keyboard.type("ore</i>")
  await expect(errorShown(page)).toHaveCount(0)
  await expect(paragraph(page, "More more").locator("i")).toHaveText("more")
  expect(fake.server.content(id, PATH)).toBe(NOTE)
})

/** From now on the page notes the most errors it showed at one moment. */
async function noteMostErrors(page: Page) {
  await page.evaluate((shown) => {
    const noted = { most: 0 }
    Object.assign(window, { mostErrors: noted })
    new MutationObserver(() => {
      const count = [...document.querySelectorAll('[role="alert"]')].filter((alert) => alert.textContent?.includes(shown) && alert.checkVisibility()).length
      noted.most = Math.max(noted.most, count)
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  }, SHOWN)
}

test("a note that does not compile shows its error once in Source, Rendered and Split, and fixing it clears the error", async ({ page, appErrors }) => {
  appErrors.expect(/Expected a closing tag/)
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  await fake.server.remote(person.id).createProject(id, "Notes")
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: "# Broken\n\nSome <b>bold words.\n" }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  await noteMostErrors(page)

  // Opened broken, the note's error shows in Source at once. Each view shows
  // it in one banner: Rendered and Split are checked once the rendered view
  // has hidden the note, when its own banner showed it too.
  await expect(errorShown(page)).toHaveCount(1)
  for (const view of ["Rendered", "Split", "Source"] as const) {
    await page.getByRole("button", { name: view, exact: true }).click()
    if (view !== "Source") await expect(page.locator(FRAME)).toBeAttached()
    await expect(page.locator(FRAME)).toBeHidden()
    await expect(errorShown(page)).toHaveCount(1)
    await expect(errorShown(page)).toContainText("Expected a closing tag")
  }

  // Fixed in Split, the error goes and the note renders.
  await page.getByRole("button", { name: "Split", exact: true }).click()
  await sourceText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("End")
  await page.keyboard.type("</b>")
  await expect(errorShown(page)).toHaveCount(0)
  await expect(paragraph(page, "Some bold words.").locator("b")).toHaveText("bold words.")
  // At no moment did the error show twice.
  expect(await page.evaluate(() => (window as unknown as { mostErrors: { most: number } }).mostErrors.most)).toBe(1)
})

/** From now on the page notes, for each click, whether the drawing's error is on screen once the click's own update has rendered. */
async function noteClicks(page: Page) {
  await page.evaluate((error) => {
    const clicks: boolean[] = []
    Object.assign(window, { clicks })
    // A task queued as a click starts runs once the click's update has rendered.
    window.addEventListener("click", () => {
      window.setTimeout(() => clicks.push([...document.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes(error))))
    }, true)
  }, NOT_A_DRAWING)
}

for (const action of ["Canvas", "Save"] as const) {
  test(`pressing ${action} right after typing JSON that is not a drawing shows its error at once, without waiting for the typing to pause`, async ({ page, appErrors }) => {
    appErrors.expect(NOT_A_DRAWING)
    const fake = await fakeSupabase(page)
    const id = crypto.randomUUID()
    await fake.server.remote(person.id).createProject(id, "Drawings")
    await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: DRAWING_PATH, content: DRAWING }])
    await signedIn(page)
    await page.goto(projectUrl(id, DRAWING_PATH))
    await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 45_000 })
    await drawingView(page, "Code").click()
    await sourceText(page).click()
    await noteClicks(page)

    // A letter after the closing brace leaves text that is not JSON.
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.type("x")
    await (action === "Canvas" ? drawingView(page, "Canvas") : page.getByRole("button", { name: "Save", exact: true })).click()
    await expect(page.getByRole("alert").filter({ hasText: NOT_A_DRAWING })).toBeVisible()
    // It showed with the click itself, not once the typing had paused.
    expect(await page.evaluate(() => (window as unknown as { clicks: boolean[] }).clicks)).toEqual([true])
    // The drawing stays in Code, and nothing was saved.
    await expect(drawingView(page, "Code")).toHaveAttribute("aria-pressed", "true")
    if (action === "Save") await expect(page.locator(".wb-native-view [aria-live]").first()).toContainText("Not saved: the file is not a valid drawing.")
    expect(fake.server.content(id, DRAWING_PATH)).toBe(DRAWING)
  })
}

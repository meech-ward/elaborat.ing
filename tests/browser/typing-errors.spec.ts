import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// While the person types a tag into a note, it does not compile until the tag
// closes. No error shows while they type, and the rendered view keeps its last
// good render; text left unable to compile says so once they pause, after a
// second (src/lib/settledError.ts). The page notes the times itself, so a slow
// machine cannot blur them.

test.describe.configure({ timeout: 60_000 })
test.use({ viewport: { width: 1280, height: 800 } })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/typing.mdx"
const NOTE = "# Typing\n\nFirst paragraph here.\n"
const SHOWN = "Source is unchanged and remains editable."

const projectUrl = (id: string, path: string) => new URL(`projects/${id}/${path}`, APP_URL).href
const paragraph = (page: Page, text: string) => page.frameLocator(FRAME).locator("p").filter({ hasText: text })
const sourceText = (page: Page) => page.locator(".monaco-editor:visible .view-lines")
const errorShown = (page: Page) => page.getByRole("alert").filter({ hasText: SHOWN })

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
  await expect(errorShown(page).first()).toBeVisible()
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

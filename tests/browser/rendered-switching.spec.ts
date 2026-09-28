import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, quiet, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Typing in a note's Rendered and Source views in turn. The frame keeps
// sending messages about older revisions of the note while the source changes
// under it, which is routine: no render error shows, even for a moment, and
// every keystroke reaches the saved file.

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const PATH = "notes/a.md"
const NOTE = "# A note\n\nFirst paragraph here.\n\nSecond paragraph here.\n"
const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href

/** Open the note, recording every render error that appears, however briefly. */
async function openNote(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = []
    Object.assign(window, { renderErrors: seen })
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.textContent?.includes("Render error:")) seen.push(node.textContent)
        }
      }
    }).observe(document, { subtree: true, childList: true })
  })
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  await signedIn(page)
  await page.goto(projectUrl(id, PATH))
  await expect(page.getByRole("tabpanel", { name: PATH })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

const renderErrors = (page: Page) => page.evaluate(() => (window as unknown as { renderErrors: string[] }).renderErrors)

test("typing in Rendered and Source in turn shows no render error, and saves exactly what was typed", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await page.getByRole("button", { name: "Rendered" }).click()
  const first = page.frameLocator(FRAME).locator("p").filter({ hasText: "First paragraph" })
  await first.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" rendered")
  for (let round = 0; round < 4; round++) {
    await page.getByRole("button", { name: "Source" }).click()
    await page.locator(".monaco-editor:visible .view-lines").first().click()
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.type(` s${round}abcdefgh`)
    await page.getByRole("button", { name: "Rendered" }).click()
    await first.click()
    await page.keyboard.press("End")
    await page.keyboard.type(` r${round}`)
  }
  await page.getByRole("button", { name: "Source" }).click()
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+s")
  await quiet(fake, 1_500)

  expect(await renderErrors(page)).toEqual([])
  expect(fake.server.content(id, PATH)).toBe(
    "# A note\n\nFirst paragraph here. rendered r0 r1 r2 r3\n\nSecond paragraph here.\n s0abcdefgh s1abcdefgh s2abcdefgh s3abcdefgh",
  )
})

test("an edit the frame made against an older revision is lost with a plain notice, not a render error", async ({ page }) => {
  await openNote(page)
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect(page.frameLocator(FRAME).locator("p").filter({ hasText: "First paragraph" })).toBeVisible()
  const frame = (await (await page.locator(FRAME).elementHandle())!.contentFrame())!
  // Remember the last document the frame was sent.
  await frame.evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.kind === "render") Object.assign(window, { lastRender: event.data })
    })
  })
  await page.getByRole("button", { name: "Source" }).click()
  await page.locator(".monaco-editor:visible .view-lines").first().click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("X")
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect.poll(() => frame.evaluate(() => (window as unknown as { lastRender?: { text?: string } }).lastRender !== undefined)).toBe(true)

  // An edit the frame made before that change arrives only now, as a race would deliver it.
  await frame.evaluate(() => {
    const render = (window as unknown as { lastRender: { session: string; revision: number; fluid?: { epoch: number } } }).lastRender
    window.parent.postMessage(
      {
        kind: "fluid-transaction",
        session: render.session,
        revision: render.revision - 1,
        epoch: render.fluid?.epoch ?? 0,
        operation: 1,
        steps: [{ stepType: "replace", from: 1, to: 1 }],
        before: { anchor: 1, head: 1 },
        after: { anchor: 1, head: 1 },
        group: "0:0",
      },
      "*",
    )
  })
  await expect(page.getByText("Edit not applied: the note changed at the same time. Make the edit again.")).toBeVisible()
  expect(await renderErrors(page)).toEqual([])
  await expect(page.frameLocator(FRAME).locator("p").filter({ hasText: "First paragraph here." })).toBeVisible()
})

test.describe("with service workers allowed", () => {
  // Playwright's service worker blocking (playwright.config.ts) runs a script
  // in every frame, which throws inside the sandboxed frame.
  test.use({ serviceWorkers: "allow" })

  test("opening a note in Rendered throws nothing, in the page or in its frame", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await openNote(page)
    await page.getByRole("button", { name: "Rendered" }).click()
    await expect(page.frameLocator(FRAME).locator("p").filter({ hasText: "First paragraph here." })).toBeVisible()
    expect(errors).toEqual([])
  })
})

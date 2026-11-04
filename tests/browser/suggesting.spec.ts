import { readFileSync } from "node:fs"
import { unzipSync } from "fflate"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, quiet, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

// Local suggestions have their own working source. Neither typing nor Save
// in review may change the ordinary file draft, sync it, or export it.
test.describe.configure({ timeout: 60_000 })
test.use({ viewport: { width: 1280, height: 900 } })

const PATH = "notes/review.mdx"
const FIRST = "The first paragraph stays precise."
const SECOND = "The second paragraph stays independent."
const NOTE = `export const hidden = { marker: "Keep this JSX and emoji 🙂" }\n\n# Review\n\n${FIRST}\n\n${SECOND}\n\n<Badge variant="secondary">Accepted component</Badge>\n`
const STALE_REVIEW = "The accepted file changed or moved. These suggestions need a new review before acceptance."
const frameOf = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]:visible')
const sourceOf = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
const reviewOf = (page: Page) => page.locator('[aria-label="Local suggestions"]')

async function openNote(page: Page, source = NOTE, path = PATH, files: Record<string, string> = {}) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Suggestion experiment")
  await remote.saveFiles(id, crypto.randomUUID(), Object.entries({ [path]: source, ...files })
    .map(([path, content]) => ({ op: "put" as const, path, content })))
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${path}`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Source")
  await expect(sourceOf(page)).toContainText("# Review")
  return { fake, id }
}

async function startSuggesting(page: Page) {
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Suggest changes locally", exact: true }).click()
  await expect(reviewOf(page)).toBeVisible()
  await expect(reviewOf(page).getByRole("heading", { name: "Suggesting locally", exact: true })).toBeVisible()
}

async function replaceSource(page: Page, source: string) {
  await showView(page, "Source")
  await sourceOf(page).click()
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest(".monaco-editor")))).toBe(true)
  // Playwright's desktop devices give Monaco a Windows user agent even
  // when the test host is macOS, so its model commands use Control.
  await page.keyboard.press("Control+a")
  await page.keyboard.press("Backspace")
  await expect(sourceOf(page)).not.toContainText("# Review")
  // Type through Monaco's ordinary keyboard path. Firefox's synthetic
  // multiline insertText composition also duplicates text in normal Editing.
  for (const [index, line] of source.split("\n").entries()) {
    if (index > 0) {
      await page.keyboard.press("Escape")
      await page.keyboard.press("Enter")
      // The new line is the document's last line. Replace any automatic
      // indentation so the helper types exactly the supplied source bytes.
      await page.keyboard.press("Home")
      await page.keyboard.press("Shift+End")
      await page.keyboard.press("Delete")
    }
    await page.keyboard.type(line)
  }
}

async function typeAtParagraphEnd(page: Page, text: string, addition: string) {
  await showView(page, "Rendered")
  const paragraph = frameOf(page).locator("p").filter({ hasText: text }).first()
  await expect(paragraph).toContainText(text)
  await paragraph.click()
  await page.keyboard.press("End")
  await page.keyboard.type(addition)
  await expect(paragraph).toHaveText(`${text}${addition}`)
}

async function leaveReviewAndSave(page: Page) {
  await reviewOf(page).getByRole("button", { name: "Return to editing", exact: true }).click()
  await expect(reviewOf(page)).toHaveCount(0)
  await page.keyboard.press("ControlOrMeta+s")
}

async function projectZip(page: Page) {
  await page.getByRole("button", { name: "Suggestion experiment, project menu", exact: true }).click()
  const downloading = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "Download project", exact: true }).click()
  const download = await downloading
  return unzipSync(new Uint8Array(readFileSync((await download.path())!)))
}

async function changedOnServer(fake: FakeSupabase, id: string, content: string) {
  const version = fake.server.projects.get(id)!.files.get(PATH)!.version
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content, base_version: version }])
  fake.signal(id, fake.server.projects.get(id)!.revision)
}

test("Source and Rendered share local suggestions while Save and project download retain accepted MDX", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await startSuggesting(page)
  await replaceSource(page, NOTE.replace(FIRST, `${FIRST} Suggested in source.`))
  await typeAtParagraphEnd(page, SECOND, " Suggested in rendered.")
  await page.keyboard.press("ControlOrMeta+s")
  await quiet(fake, 1_500)
  expect(fake.server.content(id, PATH)).toBe(NOTE)
  await expect(page.getByRole("tab", { name: `${PATH}, unsaved changes`, exact: true })).toHaveCount(0)
  await page.evaluate(() => { Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined }) })
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  const exporting = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "Export", exact: true }).click()
  const exported = await exporting
  expect(readFileSync((await exported.path())!, "utf8")).toBe(NOTE)
  const zip = await projectZip(page)
  expect(new TextDecoder().decode(zip[PATH])).toBe(NOTE)
  expect(Object.keys(zip)).toEqual([PATH])

  await showView(page, "Source")
  await expect(sourceOf(page)).toContainText("Suggested in source.")
  await expect(sourceOf(page)).toContainText("Suggested in rendered.")
  await expect(sourceOf(page)).toContainText('export const hidden = { marker: "Keep this JSX and emoji 🙂" }')
  await expect(sourceOf(page)).toContainText('<Badge variant="secondary">Accepted component</Badge>')
  await reviewOf(page).getByRole("button", { name: "Accept all", exact: true }).click()
  await leaveReviewAndSave(page)
  await expect.poll(() => fake.server.content(id, PATH)).toBe(NOTE.replace(FIRST, `${FIRST} Suggested in source.`).replace(SECOND, `${SECOND} Suggested in rendered.`))
})

test("a reload restores local proposals without syncing them, and Reject all restores accepted source", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await startSuggesting(page)
  await replaceSource(page, NOTE.replace(FIRST, "A local replacement kept across reload."))
  await page.keyboard.press("ControlOrMeta+s")
  await page.reload()
  await expect(reviewOf(page).getByRole("heading", { name: "Suggesting locally", exact: true })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Source")
  await expect(sourceOf(page)).toContainText("A local replacement kept across reload.")
  expect(fake.server.content(id, PATH)).toBe(NOTE)
  await expect(reviewOf(page).getByRole("button", { name: "Return to editing", exact: true })).toBeDisabled()
  await reviewOf(page).getByRole("button", { name: "Reject all", exact: true }).click()
  await expect(sourceOf(page)).toContainText(FIRST)
  await expect(sourceOf(page)).not.toContainText("A local replacement")
  await leaveReviewAndSave(page)
  await quiet(fake, 1_500)
  expect(fake.server.content(id, PATH)).toBe(NOTE)
})

test("separate suggestions can be rejected and accepted individually", async ({ page, browserName }) => {
  const { fake, id } = await openNote(page)
  await startSuggesting(page)
  await typeAtParagraphEnd(page, FIRST, " Reject this addition.")
  await typeAtParagraphEnd(page, SECOND, " Keep this addition.")
  const review = reviewOf(page)
  await expect(review.getByRole("button", { name: "Reject suggestion", exact: true })).toHaveCount(2)
  if (browserName === "chromium") {
    await expect(review.getByRole("status")).toHaveText("Review kept in this browser.")
    await expect(review.getByRole("button", { name: "Accept all", exact: true })).toBeEnabled()
    await page.screenshot({ path: "/tmp/elaborating-suggesting-preview.png" })
  }
  await review.getByRole("button", { name: "Reject suggestion", exact: true }).first().click()
  await expect(frameOf(page).locator("p").filter({ hasText: FIRST }).first()).toHaveText(FIRST)
  await expect(frameOf(page).locator("p").filter({ hasText: SECOND }).first()).toHaveText(`${SECOND} Keep this addition.`)
  await review.getByRole("button", { name: "Accept suggestion", exact: true }).click()
  await leaveReviewAndSave(page)
  await expect.poll(() => fake.server.content(id, PATH)).toBe(NOTE.replace(SECOND, `${SECOND} Keep this addition.`))
})

test("undo in Rendered undoes a Source proposal and redo retains it as a proposal", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await startSuggesting(page)
  await sourceOf(page).click()
  await page.keyboard.press("Control+Home")
  for (let line = 0; line < 4; line++) await page.keyboard.press("ArrowDown")
  await page.keyboard.press("End")
  await page.keyboard.type("UNDO")
  await expect(sourceOf(page)).toContainText(`${FIRST}UNDO`)
  await showView(page, "Rendered")
  const paragraph = frameOf(page).locator("p").filter({ hasText: FIRST }).first()
  await expect(paragraph).toHaveText(`${FIRST}UNDO`)
  await paragraph.click()
  await page.keyboard.press("ControlOrMeta+z")
  await expect(paragraph).toHaveText(FIRST)
  await expect(reviewOf(page).getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(0)
  await page.keyboard.press("ControlOrMeta+Shift+z")
  await expect(paragraph).toHaveText(`${FIRST}UNDO`)
  await page.keyboard.press("ControlOrMeta+s")
  await quiet(fake, 1_500)
  expect(fake.server.content(id, PATH)).toBe(NOTE)
  await reviewOf(page).getByRole("button", { name: "Reject all", exact: true }).click()
  await leaveReviewAndSave(page)
})

test("a changed accepted file blocks acceptance and preserves both the server content and proposal", async ({ page, appErrors }) => {
  appErrors.expect(STALE_REVIEW)
  const { fake, id } = await openNote(page)
  await startSuggesting(page)
  await replaceSource(page, NOTE.replace(FIRST, `${FIRST} Proposed earlier.`))
  const remoteText = NOTE.replace(SECOND, "Changed on another device.")
  await changedOnServer(fake, id, remoteText)
  const review = reviewOf(page)
  await expect(review).toContainText(STALE_REVIEW)
  await expect(review.getByRole("button", { name: "Accept all", exact: true })).toBeDisabled()
  const accepts = review.getByRole("button", { name: "Accept suggestion", exact: true })
  await expect(accepts).not.toHaveCount(0)
  for (const button of await accepts.all()) await expect(button).toBeDisabled()
  await expect(sourceOf(page)).toContainText("Proposed earlier.")
  await page.keyboard.press("ControlOrMeta+s")
  await quiet(fake, 1_500)
  expect(fake.server.content(id, PATH)).toBe(remoteText)
})

test("a moved file cannot accept its earlier local proposal, and the proposal can be exported for recovery", async ({ page, appErrors }) => {
  appErrors.expect(STALE_REVIEW)
  const { fake, id } = await openNote(page)
  await startSuggesting(page)
  const proposed = NOTE.replace(FIRST, `${FIRST} Kept for recovery.`)
  await replaceSource(page, proposed)
  await page.keyboard.press("ControlOrMeta+s")
  const version = fake.server.projects.get(id)!.files.get(PATH)!.version
  const movedPath = "notes/moved.mdx"
  await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "move", path: PATH, to: movedPath, base_version: version }])
  fake.signal(id, fake.server.projects.get(id)!.revision)
  const review = reviewOf(page)
  await expect(review.getByRole("button", { name: "Accept all", exact: true })).toBeDisabled()
  await page.evaluate(() => { Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined }) })
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  const downloading = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "Export proposed source", exact: true }).click()
  const download = await downloading
  expect(readFileSync((await download.path())!, "utf8")).toBe(proposed)
  expect(fake.server.content(id, movedPath)).toBe(NOTE)
  expect(fake.server.content(id, PATH)).toBeUndefined()
})

test("a commenter remains read-only and is not offered the local experiment", async ({ page }) => {
  const server = new FakeProjectServer()
  const owner = server.remote("5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f")
  const id = crypto.randomUUID()
  await owner.createProject(id, "Their notes")
  await owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: NOTE }])
  server.share(id, person.id, "commenter")
  await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${PATH}`, APP_URL).href)
  await expect(page.getByRole("banner").getByText("You can read and comment on this project.")).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Suggest changes locally", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await showView(page, "Source")
  await sourceOf(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type("Must stay read-only.")
  await expect(sourceOf(page)).not.toContainText("Must stay read-only.")
  expect(server.content(id, PATH)).toBe(NOTE)
})

test("the local suggestion controls are accessible", async ({ page }) => {
  await openNote(page)
  await startSuggesting(page)
  await replaceSource(page, NOTE.replace(FIRST, `${FIRST} Accessible proposal.`))
  const results = await new AxeBuilder({ page }).include('[aria-label="Local suggestions"]').analyze()
  expect(results.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([])
})

test("a plain Markdown note accepts a proposal without changing its format", async ({ page }) => {
  const path = "notes/plain.md"
  const source = "# Review\n\nPlain Markdown stays plain.\n"
  const { fake, id } = await openNote(page, source, path)
  await startSuggesting(page)
  await typeAtParagraphEnd(page, "Plain Markdown stays plain.", " Accepted as Markdown.")
  expect(fake.server.content(id, path)).toBe(source)
  await reviewOf(page).getByRole("button", { name: "Accept all", exact: true }).click()
  await leaveReviewAndSave(page)
  await expect.poll(() => fake.server.content(id, path)).toBe("# Review\n\nPlain Markdown stays plain. Accepted as Markdown.\n")
  expect(fake.server.paths(id)).toEqual([path])
})

test("Notion export uses accepted source and component output while the review renders a proposal", async ({ page }) => {
  test.setTimeout(90_000)
  const source = 'export function ReviewLabel() { return <p>Accepted custom component.</p> }\n\n# Review\n\nAccepted prose.\n\n<ReviewLabel />\n'
  const { fake, id } = await openNote(page, source)
  await startSuggesting(page)
  await replaceSource(page, source.replace("Accepted custom component.", "Proposed custom component secret.").replace("Accepted prose.", "Proposed prose secret."))
  await showView(page, "Rendered")
  await expect(frameOf(page).getByText("Proposed custom component secret.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Export to Notion", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Export to Notion", exact: true })
  await dialog.getByRole("button", { name: "Prepare export", exact: true }).click()
  await expect(dialog.getByRole("status").filter({ hasText: /^Ready:/ })).toBeVisible({ timeout: 45_000 })
  const downloading = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download ZIP", exact: true }).click()
  const download = await downloading
  const entries = unzipSync(new Uint8Array(readFileSync((await download.path())!)))
  const html = new TextDecoder().decode(entries["review.html"])
  expect(html).toContain("Accepted custom component.")
  expect(html).toContain("Accepted prose.")
  expect(html).not.toContain("Proposed custom component secret.")
  expect(html).not.toContain("Proposed prose secret.")
  expect(html).not.toContain("Suggesting locally")
  expect(fake.server.content(id, PATH)).toBe(source)
})

test("saving a parent never accepts its embedded child's local proposals", async ({ page }) => {
  const childPath = "notes/child.md"
  const childSource = "# Child\n\nAccepted child content.\n"
  const source = `# Review\n\nAccepted parent content.\n\n<Document src="${childPath}" title="Child details" />\n`
  const { fake, id } = await openNote(page, source, PATH, { [childPath]: childSource })
  await showView(page, "Rendered")
  const embed = frameOf(page).locator(`[data-document-embed="${childPath}"]`)
  await expect(embed.frameLocator("iframe").getByText("Accepted child content.", { exact: true })).toBeVisible()
  await embed.getByRole("button", { name: "Open separately", exact: true }).click()
  await expect(page.getByRole("tab", { name: childPath, exact: true })).toHaveAttribute("aria-selected", "true")
  await startSuggesting(page)
  await typeAtParagraphEnd(page, "Accepted child content.", " Proposed child change.")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(reviewOf(page).getByRole("status")).toHaveText("Review kept in this browser.")
  await page.getByRole("tab", { name: PATH, exact: true }).click()
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Save", exact: true }).click()
  await quiet(fake, 1_500)
  expect(fake.server.content(id, PATH)).toBe(source)
  expect(fake.server.content(id, childPath)).toBe(childSource)
  await page.getByRole("tab", { name: childPath, exact: true }).click()
  await showView(page, "Source")
  await expect(sourceOf(page)).toContainText("Accepted child content. Proposed child change.")
  await expect(reviewOf(page).getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(1)
})

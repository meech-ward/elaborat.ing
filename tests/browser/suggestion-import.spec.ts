import { readFileSync } from "node:fs"
import type { PortableReviewBundle } from "../../src/features/suggestions/portable.ts"
import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, quiet, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

test.describe.configure({ timeout: 60_000 })
test.use({ viewport: { width: 1280, height: 900 } })

const PATH = "notes/import-review.mdx"
const BASE = 'export const marker = "Keep this JSX and emoji 🙂"\r\n\r\n# Imported review\r\n\r\nFirst accepted paragraph.\r\n\r\nSecond accepted paragraph.\r\n'
const FIRST = "First accepted paragraph."
const SECOND = "Second accepted paragraph."
const FIRST_PROPOSED = "First proposed paragraph."
const SECOND_PROPOSED = "Second proposed paragraph."
const PROPOSED = BASE.replace(FIRST, FIRST_PROPOSED).replace(SECOND, SECOND_PROPOSED)
const reviewOf = (page: Page) => page.locator('[aria-label="Suggestions"]')
const sourceOf = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

// Generic fixtures only. Imported names are source-document provenance, not
// accounts or shared comments, and the original snapshots retain exact CRLF.
function bundle(): PortableReviewBundle {
  return {
    format: "elaborating-review", version: 1, path: PATH, base: BASE,
    suggestions: [
      { id: "first", from: BASE.indexOf(FIRST), to: BASE.indexOf(FIRST) + FIRST.length, expected: FIRST, insert: FIRST_PROPOSED, sourceIds: ["change:1"] },
      { id: "second", from: BASE.indexOf(SECOND), to: BASE.indexOf(SECOND) + SECOND.length, expected: SECOND, insert: SECOND_PROPOSED, sourceIds: ["change:2"] },
    ],
    provenance: {
      label: "Imported from Google Docs", sourceSha256: "a".repeat(64), base: BASE, proposed: PROPOSED,
      annotations: [
        { id: "change:1", sourceId: "1", kind: "ins", author: "Original reviewer", date: "2026-11-17T10:00:00Z", locator: "word/document.xml/p[1]", rawXml: "<w:ins w:id=\"1\"><w:t>First proposed paragraph.</w:t></w:ins>" },
        { id: "change:2", sourceId: "2", kind: "del", author: "Second reviewer", date: "2026-11-17T11:00:00Z", rawXml: "<w:del w:id=\"2\"/>" },
        { id: "comment:0", sourceId: "0", kind: "comment", author: "Comment author", date: "2026-11-17T12:00:00Z", text: "An original comment on proposed text.", anchor: { projection: "proposed", from: PROPOSED.indexOf(FIRST_PROPOSED), to: PROPOSED.indexOf(FIRST_PROPOSED) + FIRST_PROPOSED.length, quote: FIRST_PROPOSED } },
      ],
    },
  }
}

async function openNote(page: Page) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Imported review experiment")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: PATH, content: BASE }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${PATH}`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Source")
  await expect(sourceOf(page)).toContainText("# Imported review")
  await page.evaluate(() => { Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined }) })
  return { fake, id }
}

async function importBundle(page: Page, value = bundle()) {
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  const choosing = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "Import suggestions", exact: true }).click()
  await (await choosing).setFiles({ name: "import-review.review.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) })
}

async function exportFromMenu(page: Page, action: "Export" | "Export suggestions") {
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  const downloading = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: action, exact: true }).click()
  const download = await downloading
  return { filename: download.suggestedFilename(), text: readFileSync((await download.path())!, "utf8") }
}

test("imported suggestions stay pending through Save and reload, and portable export preserves original provenance", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await importBundle(page)
  const review = reviewOf(page)
  await expect(review.getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(2)
  await expect(review.getByRole("status")).toHaveText("Suggestions saved to the project.")
  await expect(sourceOf(page)).toContainText(FIRST_PROPOSED)
  await expect(sourceOf(page)).toContainText(SECOND_PROPOSED)
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Save suggestions", exact: true }).click()
  await quiet(fake, 1_000)
  expect(fake.server.content(id, PATH)).toBe(BASE)
  expect((await exportFromMenu(page, "Export")).text).toBe(BASE)

  await page.reload()
  await expect(review.getByRole("heading", { name: "Suggesting", exact: true })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Source")
  await expect(sourceOf(page)).toContainText(FIRST_PROPOSED)
  await expect(review.getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(2)
  await review.getByText(/Imported from Google Docs: 2 revisions and 1 comments?$/).click()
  await expect(review.getByText("An original comment on proposed text.", { exact: true })).toBeVisible()
  await expect(review.getByText("Comment · Comment author · 2026-11-17T12:00:00Z", { exact: true })).toBeVisible()
  const exported = await exportFromMenu(page, "Export suggestions")
  expect(exported.filename).toBe("import-review.review.json")
  expect(JSON.parse(exported.text)).toEqual(bundle())
  expect(Object.keys(JSON.parse(exported.text)).sort()).toEqual(["base", "format", "path", "provenance", "suggestions", "version"])
  expect(fake.server.content(id, PATH)).toBe(BASE)
})

test("rejected mismatches allow a valid retry with unfamiliar source metadata", async ({ page, appErrors }) => {
  appErrors.expect("This review bundle belongs to a different note.")
  appErrors.expect("The saved note does not match this review bundle's original source.")
  const { fake, id } = await openNote(page)
  await importBundle(page, { ...bundle(), path: "notes/other.mdx" })
  await expect(page.getByRole("alert").filter({ hasText: "This review bundle belongs to a different note." })).toBeVisible()
  await expect(reviewOf(page)).toHaveCount(0)
  await importBundle(page, { ...bundle(), base: `Different heading\r\n${BASE}`, suggestions: [] })
  await expect(page.getByRole("alert").filter({ hasText: "The saved note does not match this review bundle's original source." })).toBeVisible()
  await expect(reviewOf(page)).toHaveCount(0)
  expect(fake.server.content(id, PATH)).toBe(BASE)
  const retry = bundle()
  retry.provenance!.annotations[0].kind = "__proto__"
  await importBundle(page, retry)
  await expect(reviewOf(page).getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(2)
  await reviewOf(page).getByText(/Imported from Google Docs: 2 revisions and 1 comments?$/).click()
  await expect(reviewOf(page).locator(".local-suggestion-provenance").getByText("Document revision · Original reviewer · 2026-11-17T10:00:00Z", { exact: true })).toBeVisible()
  expect(fake.server.content(id, PATH)).toBe(BASE)
})

test("explicit partial acceptance saves only the chosen imported change and keeps the remainder pending", async ({ page }) => {
  const { fake, id } = await openNote(page)
  await importBundle(page)
  const review = reviewOf(page)
  await expect(review.getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(2)
  await review.getByRole("button", { name: "Accept suggestion", exact: true }).first().click()
  const accepted = BASE.replace(FIRST, FIRST_PROPOSED)
  await expect.poll(() => fake.server.content(id, PATH)).toBe(accepted)
  await expect(review.getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(1)
  await expect(sourceOf(page)).toContainText(SECOND_PROPOSED)
  const exported = JSON.parse((await exportFromMenu(page, "Export suggestions")).text) as PortableReviewBundle
  expect(exported.base).toBe(accepted)
  expect(exported.suggestions).toHaveLength(1)
  expect(exported.suggestions[0].sourceIds).toEqual(["change:2"])
  expect(exported.provenance).toEqual(bundle().provenance)
  await review.getByRole("button", { name: "Reject suggestion", exact: true }).click()
  await expect(sourceOf(page)).toContainText(SECOND)
  await expect(sourceOf(page)).not.toContainText(SECOND_PROPOSED)
  await expect(review.getByText("Returning to editing keeps the completed review and its original details in this project.", { exact: true })).toBeVisible()
  await expect(review.getByRole("button", { name: "Return to editing", exact: true })).toBeEnabled()
  await review.getByRole("button", { name: "Return to editing", exact: true }).click()
  await expect(review).toHaveCount(0)
  expect(fake.server.content(id, PATH)).toBe(accepted)
})

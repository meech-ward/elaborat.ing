import { readFileSync } from "node:fs"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import type { PortableReviewBundle } from "../../src/features/suggestions/portable.ts"
import { proposedSource } from "../../src/features/suggestions/review.ts"
import { expect, test, type Browser, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import type { FakeNoteReview } from "./fake-note-reviews.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

const PATH = "notes/shared-review.mdx"
const OTHER = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const reviewOf = (page: Page) => page.locator('section[aria-label="Suggestions"]')
const sourceOf = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()

/** Public synthetic content exercises the real import shape without committing a user's document. */
function bundle(count = 30): PortableReviewBundle {
  const base = 'export const marker = "Keep JSX and emoji 🙂"\r\n\r\n# Shared review\r\n\r\n' +
    Array.from({ length: count }, (_, i) => `Accepted paragraph ${i + 1}.\r\n\r\n`).join("")
  const suggestions = Array.from({ length: count }, (_, i) => {
    const expected = `Accepted paragraph ${i + 1}.`
    return { id: `source-${i + 1}`, from: base.indexOf(expected), to: base.indexOf(expected) + expected.length,
      expected, insert: `Proposed paragraph ${i + 1}.`, sourceIds: [] as string[] }
  })
  const proposed = proposedSource({ base, suggestions })
  const annotations = Array.from({ length: count === 30 ? 99 : count }, (_, i) => {
    const group = i % (count === 30 ? 34 : count)
    const owner = group % count
    const id = `change:${i}`
    suggestions[owner].sourceIds.push(id)
    return { id, sourceId: String(group), kind: i < 52 ? "ins" : i < 69 ? "del" : i < 98 ? "rPrChange" : "pPrChange",
      author: "Original reviewer", date: "2026-11-17T10:00:00Z", rawXml: `<revision id="${group}" element="${i}"/>` }
  })
  const comments = Array.from({ length: count === 30 ? 22 : 1 }, (_, i) => {
    const owner = i % count
    const quote = suggestions[owner].insert
    const id = `comment:${i}`
    suggestions[owner].sourceIds.push(id)
    return { id, sourceId: String(i), kind: "comment", author: "Comment author", date: "2026-11-17T11:00:00Z",
      text: `Comparison comment ${i + 1}.`, anchor: { projection: "proposed" as const,
        from: proposed.indexOf(quote), to: proposed.indexOf(quote) + quote.length, quote } }
  })
  return { format: "elaborating-review", version: 1, path: PATH, base, suggestions,
    provenance: { label: "Imported from Google Docs", sourceSha256: "a".repeat(64), base, proposed, annotations: [...annotations, ...comments] } }
}

async function seed(page: Page, value = bundle(), role?: "viewer") {
  const server = new FakeProjectServer()
  const owner = role ? OTHER : person.id
  const remote = server.remote(owner)
  const projectId = crypto.randomUUID()
  await remote.createProject(projectId, "Shared review comparison")
  await remote.saveFiles(projectId, crypto.randomUUID(), [{ op: "put", path: PATH, content: value.base }])
  if (role) server.share(projectId, person.id, role)
  const fake = await fakeSupabase(page, { server })
  const file = server.projects.get(projectId)!.files.get(PATH)!
  const { base, suggestions, provenance } = value
  const result = await fake.reviews.call(owner, "save_note_review", { project_id: projectId, file_id: file.id,
    review_id: crypto.randomUUID(), expected_version: null, base_version: file.version, mutation_id: crypto.randomUUID(),
    payload: { base, suggestions, provenance } }) as { review: FakeNoteReview }
  return { fake, projectId, reviewId: result.review.id, url: new URL(`projects/${projectId}/${PATH}`, APP_URL).href }
}

async function open(page: Page, url: string, count: number) {
  await signedIn(page)
  await page.goto(url)
  const review = reviewOf(page)
  await expect(review.getByRole("heading", { name: "Suggesting", exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(review.getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(count)
  await expect(review.getByRole("status")).toHaveText("Suggestions saved to the project.")
  await showView(page, "Source")
  return review
}

async function freshDevice(browser: Browser, server: FakeProjectServer, run: (page: Page, fake: FakeSupabase) => Promise<void>) {
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" })
  try {
    expect((await fresh.storageState()).origins).toEqual([])
    const page = await fresh.newPage()
    const errors: string[] = []
    page.on("pageerror", error => {
      if (!error.message.startsWith("Failed to read the 'serviceWorker' property")) errors.push(error.message)
    })
    const fake = await fakeSupabase(page, { server })
    await run(page, fake)
    expect(errors).toEqual([])
  } finally { await fresh.close() }
}

async function exportedReview(page: Page): Promise<PortableReviewBundle> {
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  const downloading = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "Export suggestions", exact: true }).click()
  const download = await downloading
  return JSON.parse(readFileSync((await download.path())!, "utf8")) as PortableReviewBundle
}

test("a fresh browser loads all pending changes and original records from the project without an import", async ({ page, browser }) => {
  const value = bundle()
  const { fake, projectId, url } = await seed(page, value)
  await open(page, url, 30)
  await expect(sourceOf(page)).toContainText("Proposed paragraph 1.")
  expect(fake.server.content(projectId, PATH)).toBe(value.base)

  await freshDevice(browser, fake.server, async (second, downloads) => {
    const review = await open(second, url, 30)
    await review.getByText("Imported from Google Docs: 34 revisions and 22 comments", { exact: true }).click()
    await expect(review.getByText("Comparison comment 22.", { exact: true }).first()).toBeVisible()
    expect(await exportedReview(second)).toEqual(value)
    expect(downloads.requests.some(request => new URL(request.url()).pathname.endsWith("/rpc/get_note_review"))).toBe(true)
    expect(await second.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("elaborating:review-draft:")))).toEqual([])
    expect(downloads.reviews).toBe(fake.reviews)
  })
  expect(fake.server.content(projectId, PATH)).toBe(value.base)
  expect(fake.reviews.calls.filter(call => call.rpc === "save_note_review")).toHaveLength(1)
  expect(fake.server.calls.filter(call => call.method === "saveFiles")).toHaveLength(1)
})

test("partial acceptance and rejection persist atomically, and finishing retains original comments in the database", async ({ page, browser }) => {
  const value = bundle(2)
  const { fake, projectId, reviewId, url } = await seed(page, value)
  const review = await open(page, url, 2)
  await review.getByRole("button", { name: "Accept suggestion", exact: true }).first().click()
  const accepted = value.base.replace("Accepted paragraph 1.", "Proposed paragraph 1.")
  await expect.poll(() => fake.server.content(projectId, PATH)).toBe(accepted)
  await expect(review.getByRole("button", { name: "Accept suggestion", exact: true })).toHaveCount(1)
  await expect(review.getByRole("status")).toHaveText("Suggestions saved to the project.")
  const record = fake.reviews.records.get(reviewId)!
  expect(record.payload.base).toBe(accepted)
  expect(record.base_version).toBe(fake.server.projects.get(projectId)!.files.get(PATH)!.version)
  expect(record.original_bundle.provenance).toEqual(value.provenance)

  await freshDevice(browser, fake.server, async second => {
    const recovered = await open(second, url, 1)
    const portable = await exportedReview(second)
    expect(portable.base).toBe(accepted)
    expect(portable.suggestions[0].id).toBe("source-2")
    expect(portable.provenance).toEqual(value.provenance)
    await recovered.getByRole("button", { name: "Reject suggestion", exact: true }).click()
    await expect(recovered.getByRole("button", { name: "Return to editing", exact: true })).toBeEnabled()
    await recovered.getByRole("button", { name: "Return to editing", exact: true }).click()
    await expect(recovered).toHaveCount(0)
  })
  const finished = fake.reviews.records.get(reviewId)!
  expect(finished.status).toBe("closed")
  expect(finished.payload.suggestions).toEqual([])
  expect(finished.payload.provenance).toEqual(value.provenance)
  expect(finished.original_bundle.provenance).toEqual(value.provenance)
  expect(fake.reviews.decisions.map(decision => decision.decision)).toEqual(["accept", "reject"])
  expect(fake.server.content(projectId, PATH)).toBe(accepted)
  await freshDevice(browser, fake.server, async second => {
    await signedIn(second)
    await second.goto(url)
    await expect(reviewOf(second)).toHaveCount(0)
    await second.getByRole("button", { name: "File actions", exact: true }).click()
    await second.getByRole("menuitem", { name: "Previous review", exact: true }).click()
    const previous = second.locator('section[aria-label="Previous review"]')
    await expect(previous.getByRole("heading", { name: "Previous review", exact: true })).toBeVisible()
    await previous.getByText("Imported from Google Docs: 2 revisions and 1 comment", { exact: true }).click()
    await expect(previous.getByText("Comparison comment 1.", { exact: true })).toBeVisible()
    const downloading = second.waitForEvent("download")
    await previous.getByRole("button", { name: "Export original review", exact: true }).click()
    const download = await downloading
    expect(JSON.parse(readFileSync((await download.path())!, "utf8"))).toEqual(value)
  })
})

test("another editor's newer review prevents stale acceptance while preserving the open proposal for export", async ({ page, appErrors }) => {
  appErrors.expect("This review or its saved file changed. Export your review before reloading the shared version.")
  const value = bundle(2)
  const { fake, projectId, reviewId, url } = await seed(page, value)
  const review = await open(page, url, 2)
  const previous = fake.reviews.records.get(reviewId)!
  await fake.reviews.call(person.id, "save_note_review", { project_id: projectId, file_id: previous.file_id,
    review_id: reviewId, expected_version: previous.version, base_version: previous.base_version, mutation_id: crypto.randomUUID(),
    payload: { ...previous.payload, suggestions: previous.payload.suggestions.slice(1) } })
  await review.getByRole("button", { name: "Accept suggestion", exact: true }).first().click()
  await expect(review.getByRole("alert").filter({ hasText: "This review or its saved file changed." })).toBeVisible()
  expect(fake.server.content(projectId, PATH)).toBe(value.base)
  expect(fake.reviews.records.get(reviewId)!.payload.suggestions).toHaveLength(1)
  expect((await exportedReview(page)).suggestions).toEqual(value.suggestions)
})

test("a viewer can read the project's pending review but cannot accept or reject its changes", async ({ page }) => {
  const value = bundle(2)
  const { fake, projectId, url } = await seed(page, value, "viewer")
  const review = await open(page, url, 2)
  await expect(review.getByRole("button", { name: "Accept all", exact: true })).toBeDisabled()
  await expect(review.getByRole("button", { name: "Reject all", exact: true })).toBeDisabled()
  await expect(review.getByRole("button", { name: "Accept suggestion", exact: true }).first()).toBeDisabled()
  await expect(review.getByRole("button", { name: "Reject suggestion", exact: true }).first()).toBeDisabled()
  expect(fake.server.content(projectId, PATH)).toBe(value.base)
  expect(fake.reviews.calls.filter(call => call.rpc === "decide_note_review")).toHaveLength(0)
})

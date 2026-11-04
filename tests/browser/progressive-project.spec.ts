import { expect, test } from "./fixtures.ts"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { imageDigest, imageObjectKeys } from "../../src/features/images/types.ts"
import { fakeSupabase, person, session, signedIn, SUPABASE } from "./fake-supabase.ts"
import { APP_URL, HARNESS_URL } from "./urls.ts"
import { recordReadiness } from "./readiness.ts"

test.use({ viewport: { width: 1280, height: 900 } })
const lines = (page: import("@playwright/test").Page) => page.locator(".monaco-editor:visible .view-lines").first()
const url = (id: string, path = "selected.md") => new URL(`projects/${id}/${path}`, APP_URL).href

async function project(imageCount = 1) {
  const server = new FakeProjectServer()
  const remote = server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Progressive project")
  await remote.saveFiles(id, crypto.randomUUID(), [
    { op: "put", path: "selected.md", content: "# Requested text\n\nReady before unrelated files." },
    ...Array.from({ length: 100 }, (_, i) => ({ op: "put" as const, path: `unrelated/${i}.md`, content: `Unrelated file ${i}` })),
  ])
  const data = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"))
  const bytes = new Blob([data], { type: "image/png" })
  const assets = []
  for (let i = 0; i < imageCount; i++) {
    const assetId = crypto.randomUUID()
    const asset = await remote.uploadImage(id, { id: assetId, ...imageObjectKeys(id, assetId), media_type: "image/png", byte_length: bytes.size, width: 1, height: 1, sha256: await imageDigest(data), preview_type: "image/png", preview_byte_length: bytes.size, preview_width: 1, preview_height: 1 }, bytes)
    assets.push(asset)
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "asset", path: i === 0 ? "unrelated/photo.png" : `unrelated/photo-${i}.png`, asset_id: asset.id }])
  }
  return { id, server, assets }
}

test("a cold selected note is usable while unrelated file metadata and image bytes remain blocked", async ({ page }, testInfo) => {
  const { id, server } = await project()
  await fakeSupabase(page, { server })
  await signedIn(page)
  let release = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  let metadataRequested = false
  let imageRequested = false
  await page.route(`${SUPABASE}/rest/v1/project_files?**`, async route => {
    const request = route.request()
    if (request.method() === "GET" && !new URL(request.url()).searchParams.has("path")) {
      metadataRequested = true
      await blocked
    }
    await route.fallback()
  })
  await page.route(`${SUPABASE}/storage/**`, async route => { imageRequested = true; await blocked; await route.fallback() })
  const start = Date.now()
  await page.goto(url(id))
  await expect(lines(page)).toContainText("Ready before unrelated files.", { timeout: 10_000 })
  const readableMs = Date.now() - start
  await recordReadiness(page, testInfo, "project-cold-readable")
  await expect(page.getByText("Loading the remaining files. You can use the files that have loaded.")).toBeVisible()
  expect(metadataRequested).toBe(true)
  expect(imageRequested).toBe(false)
  // The requested source is interactive before the complete-project read ends.
  await lines(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(" Typed while loading.")
  await expect(lines(page)).toContainText("Typed while loading.")
  // A second file link is prioritized without canceling or restarting the
  // healthy bulk pull. Returning to the first tab retains its live draft.
  await page.evaluate(href => window.history.pushState({}, "", href), url(id, "unrelated/99.md"))
  await expect(lines(page)).toContainText("Unrelated file 99")
  await page.getByRole("tab", { name: "selected.md, unsaved changes", exact: true }).click()
  await expect(lines(page)).toContainText("Typed while loading.")
  release()
  await expect(page.getByText("Loading the remaining files. You can use the files that have loaded.")).toBeHidden()
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
  await expect(page.getByText(/Preparing the offline copy:/)).toBeHidden()
  await expect(lines(page)).toContainText("Typed while loading.")
  await recordReadiness(page, testInfo, "project-all-assets")
  await testInfo.attach("progressive-project-readiness", { body: JSON.stringify({ readableMs, unrelatedFiles: 100, network: "controlled blocked metadata", budgetMs: 10_000 }), contentType: "application/json" })
})

test("an interrupted offline copy reopens its durable selected draft offline and completes after reconnecting", async ({ page }, testInfo) => {
  const { id, server } = await project()
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  let release = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  await page.route(`${SUPABASE}/storage/**`, async route => {
    if (route.request().method() !== "OPTIONS") await blocked
    await route.fallback()
  })
  await page.goto(url(id))
  await expect(lines(page)).toContainText("Ready before unrelated files.")
  await expect(page.getByText(/Preparing the offline copy: 0 of 1 images ready/)).toBeVisible()
  await recordReadiness(page, testInfo, "project-partial-readable")
  await lines(page).click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(" Durable interrupted draft.")
  await expect.poll(() => page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open("elaborating", 3); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
    const records = await new Promise<Array<{ projectId: string; draft?: { content: string } }>>((resolve, reject) => { const read = db.transaction("files").objectStore("files").getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
    db.close()
    return records.find(file => file.projectId === projectId && file.draft?.content.includes("Durable interrupted draft.")) !== undefined
  }, id)).toBe(true)
  fake.offline = true
  release()
  await page.reload()
  await expect(lines(page)).toContainText("Durable interrupted draft.", { timeout: 15_000 })
  await recordReadiness(page, testInfo, "project-partial-offline-reopen")
  await expect(page.getByText(/Preparing the offline copy:/)).toBeVisible()
  fake.offline = false
  await page.evaluate(() => window.dispatchEvent(new Event("online")))
  await expect(page.getByText(/Preparing the offline copy:/)).toBeHidden({ timeout: 15_000 })
  await expect(lines(page)).toContainText("Durable interrupted draft.")
  await recordReadiness(page, testInfo, "project-reconnected-all-assets")
  await page.reload()
  await expect(lines(page)).toContainText("Durable interrupted draft.")
  await recordReadiness(page, testInfo, "project-cached-readable")
})

test("a chat project panel opens the selected note while unrelated images are blocked", async ({ page }, testInfo) => {
  const { id, server } = await project()
  const fake = await fakeSupabase(page, { server })
  await page.addInitScript(({ origin, stored }) => {
    if (location.origin === origin) localStorage.setItem("sb-127-auth-token", stored)
  }, { origin: new URL(APP_URL).origin, stored: JSON.stringify(session()) })
  let release = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  await page.route(`${SUPABASE}/storage/**`, async route => {
    if (route.request().method() !== "OPTIONS") await blocked
    await route.fallback()
  })
  await page.goto(HARNESS_URL)
  const src = new URL(`embed/projects/${id}/selected.md#pass=${fake.mintPanelPass()}`, APP_URL).href
  await page.setContent(`<!doctype html><html lang="en"><head><title>Project panel</title><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe id="app" title="elaborat.ing" src="${src}"></iframe></body></html>`)
  const app = page.frameLocator("#app")
  await expect(app.locator(".monaco-editor:visible .view-lines").first()).toContainText("Ready before unrelated files.")
  await expect(app.getByText(/Preparing the offline copy: 0 of 1 images ready/)).toBeVisible()
  const appFrame = page.frames().find(frame => frame.url().startsWith(new URL("embed/", APP_URL).href))!
  await recordReadiness(appFrame, testInfo, "panel-cold-readable")
  release()
  await expect(app.getByText(/Preparing the offline copy:/)).toBeHidden()
  await recordReadiness(appFrame, testInfo, "panel-all-assets")
})

test("a known selected image loads ahead of blocked unrelated offline images", async ({ page }, testInfo) => {
  const { id, server, assets } = await project(5)
  await fakeSupabase(page, { server })
  await signedIn(page)
  let release = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  await page.route(`${SUPABASE}/storage/**`, async route => {
    if (route.request().method() !== "OPTIONS" && assets.slice(0, 3).some(asset => route.request().url().includes(`/${asset.id}/`))) await blocked
    await route.fallback()
  })
  await page.goto(url(id))
  await expect(lines(page)).toContainText("Ready before unrelated files.")
  await expect(page.getByText(/Preparing the offline copy: 0 of 5 images ready/)).toBeVisible()
  await page.evaluate(href => window.history.pushState({}, "", href), url(id, "unrelated/photo-4.png"))
  await expect(page.getByRole("img", { name: "photo-4.png", exact: true })).toBeVisible()
  await expect(page.getByText(/Preparing the offline copy: 1 of 5 images ready/)).toBeVisible()
  await recordReadiness(page, testInfo, "selected-image-before-offline-copy")
  release()
  await expect(page.getByText(/Preparing the offline copy:/)).toBeHidden()
})

test.describe("offline precache priority", () => {
  test.use({ serviceWorkers: "allow" })
  test("requested text becomes usable while optional precache engines are held, then the complete build finishes caching", async ({ page, context }, testInfo) => {
    test.setTimeout(90_000)
    const { id, server } = await project()
    await fakeSupabase(page, { server })
    await signedIn(page)
    let release = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    let optionalRequests = 0
    // Context routing also sees service-worker-owned requests in Chromium.
    // These optional engines are never requested by an idle Source view.
    await context.route(/\/(?:DrawingView-|DiagramView-|d2Engine-|d2-)[^/]+\.(?:js|wasm)(?:\?.*)?$/, async route => {
      optionalRequests++
      await blocked
      await route.continue()
    })
    await page.goto(url(id))
    await expect(lines(page)).toContainText("Ready before unrelated files.", { timeout: 15_000 })
    await recordReadiness(page, testInfo, "project-readable-during-precache")
    // Registration follows window load and install can proceed independently
    // of useful document content. The complete inventory is unchanged.
    if (testInfo.project.name === "chromium") await expect.poll(() => optionalRequests).toBeGreaterThan(0)
    release()
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await recordReadiness(page, testInfo, "project-whole-build-offline-ready")
    await expect(lines(page)).toContainText("Ready before unrelated files.")
  })
})

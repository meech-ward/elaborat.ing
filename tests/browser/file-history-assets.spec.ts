import { expect, test, type Locator, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { imageDigest, imageObjectKeys, type ImageAsset } from "../../src/features/images/types.ts"
import type { FileVersionContent } from "../../src/features/file-history/remote.ts"

test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 90_000 })

const RED = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")
const BLUE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYPj/H4QBDfsD/Yde1YcAAAAASUVORK5CYII=", "base64")
const projectUrl = (id: string, path: string) => new URL(`projects/${id}/${path}`, APP_URL).href
const saves = (fake: FakeSupabase) => fake.requests.filter(request => request.url().endsWith("/rpc/save_files"))

/** Complete immutable versions, separate from the fake server's tombstone-only sync history. */
async function serveHistory(page: Page, projectId: string, fileId: string, rows: FileVersionContent[]) {
  await page.route("**/rest/v1/file_versions?**", async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("file_id") !== `eq.${fileId}`) return route.fallback()
    expect(url.searchParams.get("project_id")).toBe(`eq.${projectId}`)
    const version = url.searchParams.get("version")
    const selected = rows.filter(row => !version || (version.startsWith("eq.") ? row.version === Number(version.slice(3)) : row.version < Number(version.slice(3))))
      .sort((a, b) => b.version - a.version).slice(0, Number(url.searchParams.get("limit") ?? 100))
    const fields = url.searchParams.get("select")!.split(",")
    const result = selected.map(row => Object.fromEntries(fields.map(field => [field, row[field as keyof FileVersionContent]])))
    const single = route.request().headers().accept?.includes("application/vnd.pgrst.object+json")
    await route.fulfill({
      status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" },
      body: JSON.stringify(single ? result[0] ?? null : result),
    })
  })
}

function version(fileId: string, path: string, at: number, content: string, asset: ImageAsset | null = null): FileVersionContent {
  return {
    file_id: fileId, path, version: at, content, kind: asset ? "image" : "text", asset,
    author_id: person.id, deleted: false, created_at: `2026-11-${at === 1 ? "11" : "12"}T12:00:00.000Z`,
  }
}

async function expand(details: Locator) {
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click()
}

async function originalSave(page: Page) {
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Version history", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Version history", exact: true })
  const originalDay = dialog.locator("summary").filter({ hasText: /^November 11, 2026/ }).locator("..")
  await expect(originalDay).toBeVisible()
  await expand(originalDay)
  const original = dialog.locator("summary").filter({ hasText: /^Version 1\b/ }).locator("..")
  await expand(original)
  return { dialog, original }
}

test("restoring an image saves its original immutable asset as a new version and keeps both assets and all history", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  const path = "photo.png"
  await remote.createProject(id, "Image history")
  const stage = async (bytes: Buffer, width: number): Promise<ImageAsset> => {
    const assetId = crypto.randomUUID()
    return remote.uploadImage!(id, {
      id: assetId, ...imageObjectKeys(id, assetId), media_type: "image/png", width, height: 1,
      byte_length: bytes.length, sha256: await imageDigest(new Uint8Array(bytes)),
      preview_type: "image/png", preview_byte_length: bytes.length, preview_width: width, preview_height: 1,
    }, new Blob([new Uint8Array(bytes)], { type: "image/png" }))
  }
  const originalAsset = await stage(RED, 1)
  const currentAsset = await stage(BLUE, 2)
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "asset", path, asset_id: originalAsset.id }])
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "asset", path, asset_id: currentAsset.id, base_version: 1 }])
  const fileId = fake.server.projects.get(id)!.files.get(path)!.id
  const rows = [version(fileId, path, 1, "", originalAsset), version(fileId, path, 2, "", currentAsset)]
  const originals = structuredClone(rows)
  const priorHistory = structuredClone(fake.server.projects.get(id)!.history)
  await serveHistory(page, id, fileId, rows)
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  const image = page.getByRole("img", { name: path, exact: true })
  await expect(image).toBeVisible({ timeout: 15_000 })
  await expect(image).toHaveJSProperty("naturalWidth", 2)
  const { dialog, original } = await originalSave(page)
  await expect(original.getByRole("img", { name: "After preview", exact: true })).toBeVisible()
  await original.getByRole("button", { name: "Restore version 1", exact: true }).click()
  await expect.poll(() => fake.server.projects.get(id)!.files.get(path)!.asset?.id).toBe(originalAsset.id)
  expect(saves(fake).at(-1)!.postDataJSON().changes).toEqual([{ op: "asset", path, asset_id: originalAsset.id, base_version: 2 }])
  expect(fake.server.projects.get(id)!.history).toEqual([...priorHistory, { fileId, version: 3, deleted: false }])
  expect(rows).toEqual(originals)
  for (const [asset, bytes] of [[originalAsset, RED], [currentAsset, BLUE]] as const) {
    const retained = fake.server.assets.get(`${id}/${asset.id}`)!
    expect(Buffer.from(await retained.bytes.arrayBuffer())).toEqual(bytes)
  }
  const reads = fake.requests.filter(request => request.url().includes(`/project-images/${id}/${originalAsset.id}/`))
  expect(reads.some(request => request.url().endsWith("/original"))).toBe(true)
  expect(reads.some(request => request.url().endsWith("/preview"))).toBe(true)
  expect(fake.requests.filter(request => new URL(request.url()).pathname === "/functions/v1/images")).toHaveLength(0)
  await dialog.getByRole("button", { name: "Close version history", exact: true }).click()
  await expect(image).toHaveJSProperty("naturalWidth", 1)
  expect(await image.evaluate(async element => [...new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())])).toEqual([...RED])
})

/** Observe sync completion without changing any device records or bypassing its normal save flow. */
async function localBaseVersion(page: Page, projectId: string, path: string): Promise<number | null> {
  return page.evaluate(({ projectId, path }) => new Promise<number | null>((resolve, reject) => {
    const opening = indexedDB.open("elaborating")
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const tx = db.transaction("files", "readonly")
      const request = tx.objectStore("files").getAll()
      request.onsuccess = () => resolve(request.result.find(file => file.projectId === projectId && file.path === path)?.base?.version ?? null)
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => db.close()
    }
  }), { projectId, path })
}

test("restoring D2 compiles the historical source and saves all three files together over their checked revisions, retaining freehand shapes", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  const path = "flow.d2"
  const nativePath = "flow.excalidraw"
  const sidecarPath = "flow.d2.json"
  const oldSource = "a -> b: original\n"
  const currentSource = "a -> b: current\nb -> c\n"
  await remote.createProject(id, "Diagram history")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content: oldSource }])
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content: currentSource, base_version: 1 }])
  const fileId = fake.server.projects.get(id)!.files.get(path)!.id
  const rows = [version(fileId, path, 1, oldSource), version(fileId, path, 2, currentSource)]
  const originals = structuredClone(rows)
  await serveHistory(page, id, fileId, rows)
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 45_000 })
  await expect.poll(() => fake.server.content(id, sidecarPath)).toBeDefined()
  const canvas = JSON.parse(fake.server.content(id, nativePath)!)
  const freehand = {
    id: "history-freehand", type: "ellipse", x: 600, y: 300, width: 100, height: 70, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
    roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "b0", roundness: null, seed: 7,
    version: 1, versionNonce: 7, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
  }
  canvas.elements.push(freehand)
  const project = fake.server.projects.get(id)!
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: nativePath, content: `${JSON.stringify(canvas)}\n`, base_version: project.files.get(nativePath)!.version }])
  fake.signal(id, project.revision)
  await expect.poll(() => localBaseVersion(page, id, nativePath)).toBe(project.files.get(nativePath)!.version)
  const priorHistory = structuredClone(project.history)
  const before = new Map([path, nativePath, sidecarPath].map(file => [file, project.files.get(file)!.version]))
  const priorHash = JSON.parse(fake.server.content(id, sidecarPath)!).sourceHash
  const saveCount = saves(fake).length
  const { original } = await originalSave(page)
  await original.getByRole("button", { name: "Restore version 1", exact: true }).click()
  await expect.poll(() => fake.server.content(id, path), { timeout: 45_000 }).toBe(oldSource)
  const restoreSaves = saves(fake).slice(saveCount)
  expect(restoreSaves).toHaveLength(1)
  const changes = restoreSaves[0].postDataJSON().changes as Array<{ op: string; path: string; content: string; base_version: number }>
  expect(changes.map(change => change.path).sort()).toEqual([path, sidecarPath, nativePath].sort())
  for (const change of changes) {
    expect(change.op).toBe("put")
    expect(change.base_version).toBe(before.get(change.path))
  }
  const restored = JSON.parse(fake.server.content(id, nativePath)!)
  expect(restored.elements.find((element: { id: string }) => element.id === freehand.id)).toMatchObject(freehand)
  expect(restored.elements.some((element: { text?: string; isDeleted?: boolean }) => !element.isDeleted && element.text === "original")).toBe(true)
  expect(restored.elements.some((element: { text?: string; isDeleted?: boolean }) => !element.isDeleted && element.text === "current")).toBe(false)
  const sidecar = JSON.parse(fake.server.content(id, sidecarPath)!)
  expect(sidecar.sourceHash).not.toBe(priorHash)
  expect(sidecar.baseline.sourceHash).toBe(sidecar.sourceHash)
  const savedRevision = project.files.get(path)!.version
  expect(new Set([path, nativePath, sidecarPath].map(file => project.files.get(file)!.version))).toEqual(new Set([savedRevision]))
  expect(project.history).toEqual([...priorHistory, ...changes.map(change => ({ fileId: project.files.get(change.path)!.id, version: savedRevision, deleted: false }))])
  expect(rows).toEqual(originals)
})

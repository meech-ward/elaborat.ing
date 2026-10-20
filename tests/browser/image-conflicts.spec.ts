import AxeBuilder from "./axe.ts"
import { expect, test } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { imageDigest, imageObjectKeys, type ImageAsset } from "../../src/features/images/types.ts"

const red = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")
const blue = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYPj/H4QBDfsD/Yde1YcAAAAASUVORK5CYII=", "base64")

test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })

test("an offline image conflict compares both cached versions and Keep both preserves their bytes", async ({ page, appErrors }) => {
  appErrors.expect("was changed on another device too, so its sync stopped.")
  appErrors.expect("Changed in two places: choose which version to keep")
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Image conflicts")
  const stage = async (bytes: Buffer, width: number): Promise<ImageAsset> => {
    const assetId = crypto.randomUUID()
    return remote.uploadImage!(id, { id: assetId, ...imageObjectKeys(id, assetId), media_type: "image/png", width, height: 1, byte_length: bytes.length, sha256: await imageDigest(new Uint8Array(bytes)), preview_type: "image/png", preview_byte_length: bytes.length, preview_width: width, preview_height: 1 }, new Blob([new Uint8Array(bytes)], { type: "image/png" }))
  }
  const original = await stage(red, 1)
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "asset", path: "photo.png", asset_id: original.id }])
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/photo.png`, APP_URL).href)
  await expect(page.getByRole("img", { name: "photo.png", exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible()
  const mine = await stage(red, 1)
  const theirs = await stage(blue, 2)
  const version = fake.server.projects.get(id)!.files.get("photo.png")!.version
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "asset", path: "photo.png", asset_id: theirs.id, base_version: version }])
  const serverFile = fake.server.projects.get(id)!.files.get("photo.png")!
  fake.offline = true
  // Recover the same durable conflict state produced by ProjectSync (whose
  // two-device transition is covered by the storage tests). All UI choices
  // below go through the actual workbench and account-partitioned store.
  await page.evaluate(async ({ projectId, mine, theirs, serverFile, red, blue }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("elaborating")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["files", "assets"], "readwrite")
      const request = tx.objectStore("files").getAll()
      request.onsuccess = () => {
        const file = request.result.find(file => file.projectId === projectId && file.path === "photo.png")
        if (!file) throw new Error("The image was not cached")
        tx.objectStore("files").put({ ...file, asset: mine, asset_id: mine.id, batch: crypto.randomUUID(), conflict: { pathTaken: false, current: { id: serverFile.id, version: serverFile.version, content: "", kind: "image", asset_id: theirs.id, asset: theirs } } })
        for (const [asset, array] of [[mine, red], [theirs, blue]] as const) {
          const bytes = new Blob([new Uint8Array(array)], { type: "image/png" })
          tx.objectStore("assets").put({ partition: file.partition, projectId, id: asset.id, asset, bytes, preview: bytes, uploaded: true })
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  }, { projectId: id, mine, theirs, serverFile, red: [...red], blue: [...blue] })
  await page.reload()
  await page.getByRole("button", { name: "Compare", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Compare photo.png", exact: true })
  const serverImage = dialog.getByRole("img", { name: "The image on the server", exact: true })
  const localImage = dialog.getByRole("img", { name: "The image on this device", exact: true })
  await expect(serverImage).toBeVisible()
  await expect(localImage).toBeVisible()
  await expect(dialog).toContainText("2 × 1")
  expect(await serverImage.evaluate(async element => [...new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())])).toEqual([...blue])
  expect(await localImage.evaluate(async element => [...new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())])).toEqual([...red])
  expect((await new AxeBuilder({ page }).include(".wb-compare").analyze()).violations).toEqual([])
  await dialog.getByRole("button", { name: "Keep both", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("alert").filter({ hasText: "was changed on another device too" })).toHaveCount(0)
  fake.offline = false
  await page.reload()
  await expect.poll(() => [...fake.server.projects.get(id)!.files.values()].filter(file => file.kind === "image").length).toBe(2)
  const images = [...fake.server.projects.get(id)!.files.values()]
  expect(images.find(file => file.path === "photo.png")!.asset?.id).toBe(theirs.id)
  expect(images.find(file => file.path !== "photo.png")!.asset?.id).toBe(mine.id)
})

import { expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"
import { IndexedProjectDatabase, MemoryProjectDatabase } from "./database"
import { ProjectFileStore } from "./fileStore"
import { ensureLocalProject, LOCAL_PARTITION, LOCAL_PROJECT_ID, moveLocalProject } from "./localProject"
import { type ImageAsset } from "./model"
import { ProjectSync } from "./sync"
import { RemoteError } from "./remote"
import { device, FakeProjectServer, OWNER, OTHER } from "./testing"
import { imageDigest, imageObjectKeys } from "../images/types"

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0))
async function image(projectId: string, changed = false) {
  const id = crypto.randomUUID()
  const bytes = new Blob([changed ? Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYPj/H4QBDfsD/Yde1YcAAAAASUVORK5CYII="), (character) => character.charCodeAt(0)) : PNG], { type: "image/png" })
  const asset: ImageAsset = { id, ...imageObjectKeys(projectId, id), media_type: "image/png", byte_length: bytes.size, width: changed ? 2 : 1, height: 1, sha256: await imageDigest(new Uint8Array(await bytes.arrayBuffer())), preview_type: "image/png", preview_byte_length: bytes.size, preview_width: 1, preview_height: 1 }
  return { bytes, asset }
}

async function ready() {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Pictures")
  expect((await a.sync.sync(id)).status).toBe("synced")
  return { server, a, id, store: a.files(id) }
}

test("an image draft and its note survive IndexedDB reload in their own account", async () => {
  const factory = new IDBFactory()
  const db = new IndexedProjectDatabase(factory, crypto.randomUUID())
  const a = device(new FakeProjectServer(), OWNER, db)
  const { id } = await a.sync.createProject("Offline")
  const { bytes, asset } = await image(id)
  await a.files(id).stageImage("assets/photo.png", bytes, asset, [{ path: "note.md", content: "![Photo](assets/photo.png)", baseRevision: null }], bytes)
  const again = new ProjectFileStore(db, a.partition, id)
  expect(await again.read("assets/photo.png")).toMatchObject({ kind: "image", content: "", savedContent: null, draft: true, asset: { id: asset.id } })
  expect(new Uint8Array(await (await again.readImage("assets/photo.png")).arrayBuffer())).toEqual(PNG)
  expect((await again.read("note.md")).content).toBe("![Photo](assets/photo.png)")
  const other = device(new FakeProjectServer(), OTHER, db)
  await expect(other.files(id).readImage("assets/photo.png")).rejects.toThrow("not on this device")
  await expect(other.files(id).readImageAsset(asset.id)).rejects.toThrow("not on this device")
})

test("IndexedDB upgrades a text-only v1 database without losing its text", async () => {
  const factory = new IDBFactory()
  const name = crypto.randomUUID()
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore("projects", { keyPath: ["partition", "id"] }).createIndex("partition", "partition")
      const files = db.createObjectStore("files", { keyPath: ["partition", "projectId", "path"] })
      files.createIndex("project", ["partition", "projectId"])
      files.createIndex("baseId", ["partition", "projectId", "base.id"])
      db.createObjectStore("folders", { keyPath: ["partition", "projectId", "path"] }).createIndex("project", ["partition", "projectId"])
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(["projects", "files"], "readwrite")
      tx.objectStore("projects").put({ partition: LOCAL_PARTITION, id: LOCAL_PROJECT_ID, title: "Local project", pendingTitle: null, role: "owner", revision: 0, created: false, archivedAt: null, syncError: null, pending: null })
      tx.objectStore("files").put({ partition: LOCAL_PARTITION, projectId: LOCAL_PROJECT_ID, localId: crypto.randomUUID(), path: "note.md", base: null, content: "Keep original text.", batch: null, draft: { content: "An old recovered draft.", token: null }, conflict: null })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
  const db = new IndexedProjectDatabase(factory, name)
  await ensureLocalProject(db, async () => undefined, async () => [{ path: "note.md", content: "Keep original text." }])
  const store = new ProjectFileStore(db, LOCAL_PARTITION, LOCAL_PROJECT_ID)
  expect(await store.read("note.md")).toMatchObject({ content: "An old recovered draft.", savedContent: "Keep original text.", draft: true })
  const { bytes, asset } = await image(LOCAL_PROJECT_ID)
  await store.stageImage("a.png", bytes, asset)
  expect((await store.readImage("a.png")).size).toBe(bytes.size)
})

test("staging refuses mismatched bytes and rolls back a failing note dependency", async () => {
  const { a, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await expect(store.stageImage("photo.png", bytes, { ...asset, sha256: "0".repeat(64) })).rejects.toThrow("digest")
  await expect(store.stageImage("photo.png", bytes, asset, [{ path: "photo.png", content: "overwrite", baseRevision: null }])).rejects.toThrow("not a note")
  expect((await store.listEntries()).files).toEqual([])
  expect(await a.db.transaction(a.partition, "readonly", (tx) => tx.listAssets(id))).toEqual([])
})

test("offline Save keeps image bytes and note changes in one durable batch before upload", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset, [{ path: "note.md", content: "![Photo](photo.png)", baseRevision: null }], bytes)
  await store.saveImages(["photo.png"], [{ path: "note.md", content: "![Photo](photo.png)", expectedRevision: null }])
  server.offline = true
  expect((await a.sync.sync(id)).status).toBe("offline")
  expect(server.content(id, "note.md")).toBeUndefined()
  expect((await a.project(id))?.pending?.changes.map((change) => change.op).sort()).toEqual(["asset", "put"])
  server.offline = false
  expect((await a.sync.sync(id)).status).toBe("synced")
  const save = server.calls.findLast((call) => call.method === "saveFiles")!
  expect((save.args[2] as unknown[]).length).toBe(2)
  expect(server.content(id, "note.md")).toBe("![Photo](photo.png)")
  expect(server.calls.findIndex((call) => call.method === "uploadImage")).toBeLessThan(server.calls.findIndex((call) => call.method === "saveFiles"))
  const b = device(server, OWNER)
  await b.sync.download((await b.sync.refresh()).find((project) => project.id === id)!)
  server.offline = true
  expect(new Uint8Array(await (await b.files(id).readImage("photo.png")).arrayBuffer())).toEqual(PNG)
  expect((await b.files(id).read("photo.png")).unsynced).toBe(false)
})

test("a lost upload answer retries the same image identity before saving the note once", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset)
  await store.saveImages(["photo.png"], [{ path: "note.md", content: "![Photo](photo.png)", expectedRevision: null }])
  server.loseResponses = 1
  expect((await a.sync.sync(id)).status).toBe("offline")
  const pending = (await a.project(id))!.pending!.mutationId
  expect(server.saves()).toBe(0)
  expect((await a.sync.sync(id)).status).toBe("synced")
  expect(server.assets.size).toBe(1)
  expect(server.saves()).toBe(1)
  expect(server.calls.filter((call) => call.method === "uploadImage").map((call) => (call.args[1] as ImageAsset).id)).toEqual([asset.id])
  expect(server.calls.find((call) => call.method === "saveFiles")!.args[1]).toBe(pending)
})

test("upload success and save failure retain the draft bytes and reuse the staged asset", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset)
  await store.saveImages(["photo.png"], [{ path: "note.md", content: "![Photo](photo.png)", expectedRevision: null }])
  const remote = server.remote(OWNER)
  let fail = true
  const sync = new ProjectSync(a.db, { ...remote, saveFiles: (...args) => { if (fail) { fail = false; throw new RemoteError("network", "Lost connection") }; return remote.saveFiles(...args) } }, a.partition)
  expect((await sync.sync(id)).status).toBe("offline")
  expect((await store.readImage("photo.png")).size).toBe(bytes.size)
  expect(server.content(id, "note.md")).toBeUndefined()
  expect((await sync.sync(id)).status).toBe("synced")
  expect(server.calls.filter((call) => call.method === "uploadImage")).toHaveLength(1)
})

test("a failed image download cannot advance the project's offline revision", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset)
  await store.saveImages(["photo.png"])
  await a.sync.sync(id)
  const b = device(server)
  const remote = server.remote(OWNER)
  const sync = new ProjectSync(b.db, { ...remote, downloadImage: async () => { throw new RemoteError("network", "Image unavailable") } }, b.partition)
  const entry = (await remote.listProjects()).find((project) => project.id === id)!
  await expect(sync.download(entry)).rejects.toThrow("Image unavailable")
  expect((await b.project(id))?.revision).toBe(0)
  await b.sync.download(entry)
  expect((await b.files(id).readImage("photo.png")).size).toBe(bytes.size)
})

test("discarding an image replacement keeps the saved image and evicts only its unused staging bytes", async () => {
  const { store, id, a } = await ready()
  const first = await image(id)
  await store.stageImage("photo.png", first.bytes, first.asset)
  await store.saveImages(["photo.png"])
  const replacement = await image(id, true)
  await store.stageImage("photo.png", replacement.bytes, replacement.asset)
  expect((await store.readImage("photo.png")).size).toBe(replacement.bytes.size)
  await store.discardDraft("photo.png")
  expect((await store.readImage("photo.png")).size).toBe(first.bytes.size)
  expect(await a.db.transaction(a.partition, "readonly", (tx) => tx.listAssets(id))).toHaveLength(1)
  await expect(store.write("photo.png", "", (await store.read("photo.png")).revision)).rejects.toThrow("cannot be overwritten with text")
})

test("image conflicts keep both immutable versions and taking theirs adopts its metadata and bytes", async () => {
  const { store, id, a, server } = await ready()
  const first = await image(id)
  await store.stageImage("photo.png", first.bytes, first.asset)
  await store.saveImages(["photo.png"])
  await a.sync.sync(id)
  const b = device(server)
  await b.sync.download((await b.sync.refresh()).find((project) => project.id === id)!)
  const theirs = await image(id, true)
  await store.stageImage("photo.png", theirs.bytes, theirs.asset)
  await store.saveImages(["photo.png"])
  await a.sync.sync(id)
  const mine = await image(id)
  await b.files(id).stageImage("photo.png", mine.bytes, mine.asset)
  await b.files(id).saveImages(["photo.png"])
  await b.sync.sync(id)
  expect((await b.files(id).read("photo.png")).conflict).toBe(true)
  expect(await b.files(id).conflictCopies("photo.png")).toMatchObject({ mine: "", theirs: "", mineAsset: { id: mine.asset.id }, theirsAsset: { id: theirs.asset.id } })
  server.offline = true
  expect((await b.files(id).readImageAsset(mine.asset.id, true)).size).toBe(mine.bytes.size)
  expect((await b.files(id).readImageAsset(theirs.asset.id, true)).size).toBe(theirs.bytes.size)
  server.offline = false
  await b.sync.resolve(id, "photo.png", "theirs")
  expect((await b.files(id).read("photo.png")).asset?.id).toBe(theirs.asset.id)
  expect((await b.files(id).readImage("photo.png")).size).toBe(theirs.bytes.size)
})

test("signing in moves local image drafts and bytes with the note and deletion removes only that partition", async () => {
  const db = new MemoryProjectDatabase()
  await ensureLocalProject(db, async () => undefined)
  const local = new ProjectFileStore(db, LOCAL_PARTITION, LOCAL_PROJECT_ID)
  const { bytes, asset } = await image(LOCAL_PROJECT_ID)
  await local.stageImage("photo.png", bytes, asset, [{ path: "note.md", content: "![Photo](photo.png)", baseRevision: null }])
  const a = device(new FakeProjectServer(), OWNER, db)
  const id = (await moveLocalProject(db, a.partition))!
  expect((await a.files(id).readImage("photo.png")).size).toBe(bytes.size)
  expect((await a.files(id).read("note.md")).draft).toBe(true)
  await expect(local.readImage("photo.png")).rejects.toThrow("not on this device")
  await a.sync.forget(id)
  expect(await db.transaction(a.partition, "readonly", (tx) => tx.listAssets(id))).toEqual([])
})

test("an unsynced image replacement and its move upload and save the new bytes together", async () => {
  const { a, server, id, store } = await ready()
  const first = await image(id)
  await store.stageImage("photo.png", first.bytes, first.asset)
  await store.saveImages(["photo.png"])
  await a.sync.sync(id)
  const replacement = await image(id, true)
  await store.stageImage("photo.png", replacement.bytes, replacement.asset)
  await store.saveImages(["photo.png"])
  await store.move("photo.png", "moved.png", (await store.read("photo.png")).revision)
  expect((await a.sync.sync(id)).status).toBe("synced")
  const changes = server.calls.findLast((call) => call.method === "saveFiles")!.args[2]
  expect(changes).toEqual([{ op: "move", path: "photo.png", to: "moved.png", base_version: 1, asset_id: replacement.asset.id }])
  expect(server.projects.get(id)!.files.get("moved.png")!.asset?.id).toBe(replacement.asset.id)
  expect((await store.read("moved.png")).unsynced).toBe(false)
})

test("a committed historical image can be cached without a draft and restored atomically with a move", async () => {
  const { a, server, id, store } = await ready()
  const historical = await image(id)
  await store.stageImage("photo.png", historical.bytes, historical.asset)
  await store.saveImages(["photo.png"])
  await a.sync.sync(id)
  const replacement = await image(id, true)
  await store.stageImage("photo.png", replacement.bytes, replacement.asset)
  await store.saveImages(["photo.png"])
  await a.sync.sync(id)
  const revision = (await store.read("photo.png")).revision
  await store.cacheImage(historical.bytes, historical.asset)
  expect(await store.draftImageAsset("photo.png")).toBeNull()
  expect((await store.read("photo.png")).asset?.id).toBe(replacement.asset.id)
  await expect(store.cacheImage(historical.bytes, { ...historical.asset, object_key: `${crypto.randomUUID()}/${historical.asset.id}/original`, preview_key: `${crypto.randomUUID()}/${historical.asset.id}/preview` })).rejects.toThrow()
  await store.save([{ kind: "move", from: "photo.png", to: "restored.png", expectedRevision: revision, asset: historical.asset }])
  expect((await store.readImage("restored.png")).size).toBe(historical.bytes.size)
  expect((await a.sync.sync(id)).status).toBe("synced")
  expect(server.projects.get(id)!.files.get("restored.png")!.asset?.id).toBe(historical.asset.id)
  expect(server.calls.filter((call) => call.method === "uploadImage")).toHaveLength(2)
})

test("upload replaces a browser WebP preview with the server's verified PNG preview", async () => {
  const server = new FakeProjectServer()
  const db = new MemoryProjectDatabase()
  const partition = device(server).partition
  const remote = server.remote(OWNER)
  const upload = remote.uploadImage.bind(remote)
  const serverPreview = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2])], { type: "image/png" })
  remote.uploadImage = async (projectId, asset, bytes) => {
    const verified = await upload(projectId, asset, bytes)
    const accepted = { ...verified, preview_type: "image/png" as const, preview_byte_length: serverPreview.size }
    server.assets.set(`${projectId}/${asset.id}`, { projectId, asset: accepted, bytes, preview: serverPreview })
    return accepted
  }
  const sync = new ProjectSync(db, remote, partition)
  const { id } = await sync.createProject("SVG previews")
  expect((await sync.sync(id)).status).toBe("synced")
  const store = new ProjectFileStore(db, partition, id)
  const base = await image(id)
  const bytes = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>'], { type: "image/svg+xml" })
  const asset: ImageAsset = { ...base.asset, media_type: "image/svg+xml", byte_length: bytes.size, sha256: await imageDigest(new Uint8Array(await bytes.arrayBuffer())) }
  const browserPreview = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" })
  await store.stageImage("photo.svg", bytes, { ...asset, preview_type: "image/webp", preview_byte_length: browserPreview.size }, [], browserPreview)
  await store.saveImages(["photo.svg"])
  expect((await sync.sync(id)).status).toBe("synced")
  const cached = await db.transaction(partition, "readonly", tx => tx.getAsset(id, asset.id))
  expect(cached?.preview?.type).toBe("image/png")
  expect(cached?.preview?.size).toBe(serverPreview.size)
  expect(new Uint8Array(await cached!.preview!.arrayBuffer())).toEqual(new Uint8Array(await serverPreview.arrayBuffer()))
  expect((await store.read("photo.svg")).asset?.preview_type).toBe("image/png")
})

test("pull repairs a cached preview with the right original but wrong preview codec or size", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset, [], bytes)
  await store.saveImages(["photo.png"])
  expect((await a.sync.sync(id)).status).toBe("synced")
  const b = device(server, OWNER)
  const project = (await b.sync.refresh()).find(project => project.id === id)!
  await b.sync.download(project)
  for (const preview of [new Blob([PNG], { type: "image/webp" }), new Blob([PNG.slice(0, 3)], { type: "image/png" })]) {
    await b.db.transaction(b.partition, "readwrite", async tx => {
      const cached = (await tx.getAsset(id, asset.id))!
      await tx.putAsset({ ...cached, preview })
      const local = (await tx.getProject(id))!
      await tx.putProject({ ...local, revision: 0 })
    })
    const calls = server.calls.length
    expect((await b.sync.sync(id)).status).toBe("synced")
    const cached = await b.db.transaction(b.partition, "readonly", tx => tx.getAsset(id, asset.id))
    expect(cached?.preview?.type).toBe(asset.preview_type)
    expect(cached?.preview?.size).toBe(asset.preview_byte_length)
    expect(server.calls.slice(calls).filter(call => call.method === "downloadImage").map(call => call.args[2])).toEqual([true])
  }
})

test("a wrong-codec server preview prevents acknowledging the image save", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset, [], bytes)
  await store.saveImages(["photo.png"])
  const remote = server.remote(OWNER)
  const download = remote.downloadImage.bind(remote)
  remote.downloadImage = async (projectId, asset, preview) => preview ? new Blob([PNG], { type: "image/webp" }) : await download(projectId, asset, preview)
  const sync = new ProjectSync(a.db, remote, a.partition)
  expect((await sync.sync(id)).status).toBe("stopped")
  expect(server.content(id, "photo.png")).toBeUndefined()
  expect((await store.read("photo.png")).unsynced).toBe(true)
  expect((await store.readImage("photo.png")).size).toBe(bytes.size)
})

test("discarding a note removes only its newly staged image dependencies and their bytes", async () => {
  const { store, id, a } = await ready()
  const first = await image(id)
  await store.stageImage("assets/photo.png", first.bytes, first.asset, [{ path: "note.mdx", content: "![Photo](assets/photo.png)", baseRevision: null }])
  await store.discardDraft("note.mdx")
  expect((await store.listEntries()).files).toEqual([])
  expect(await a.db.transaction(a.partition, "readonly", tx => tx.listAssets(id))).toEqual([])
})

test("discarding one note retains images used by another draft or saved source", async () => {
  const { store, id } = await ready()
  const first = await image(id)
  await store.stageImage("assets/photo.png", first.bytes, first.asset, [{ path: "a.mdx", content: "![A](assets/photo.png)", baseRevision: null }, { path: "b.md", content: "![B][photo]\n\n[photo]: assets/photo.png", baseRevision: null }])
  await store.discardDraft("a.mdx")
  expect((await store.read("assets/photo.png")).draft).toBe(true)
  expect((await store.readImage("assets/photo.png")).size).toBe(first.bytes.size)
  await store.write("b.md", (await store.read("b.md")).content, null)
  await store.persistDrafts([{ path: "a.mdx", content: "![A](assets/photo.png)", baseRevision: null }])
  await store.discardDraft("a.mdx")
  expect((await store.read("assets/photo.png")).draft).toBe(true)
})

test("discarding a resized image also removes its unused original draft, while saved images stay", async () => {
  const { store, id, a } = await ready()
  const original = await image(id)
  const derived = await image(id, true)
  await store.stageImage("original.png", original.bytes, original.asset)
  await store.stageImage("copy.png", derived.bytes, { ...derived.asset, original_path: "original.png" }, [{ path: "note.mdx", content: "![Copy](copy.png)", baseRevision: null }])
  await store.discardDraft("note.mdx")
  expect((await store.listEntries()).files).toEqual([])
  expect(await a.db.transaction(a.partition, "readonly", tx => tx.listAssets(id))).toEqual([])
  await store.stageImage("saved.png", original.bytes, original.asset)
  await store.saveImages(["saved.png"])
  await store.persistDrafts([{ path: "note.mdx", content: "![Saved](saved.png)", baseRevision: null }])
  await store.discardDraft("note.mdx")
  expect((await store.read("saved.png")).draft).toBe(false)
})

test("cancelled staging evicts unuploaded bytes, but committed historical assets stay cached", async () => {
  const { store, id } = await ready()
  const cancelled = await image(id)
  await store.stageImage("cancel.png", cancelled.bytes, cancelled.asset)
  await store.discardDraft("cancel.png")
  await expect(store.readImageAsset(cancelled.asset.id)).rejects.toThrow("not downloaded")
  const committed = await image(id)
  await store.cacheImage(committed.bytes, committed.asset)
  await store.stageImage("history.png", committed.bytes, committed.asset)
  await store.discardDraft("history.png")
  expect((await store.readImageAsset(committed.asset.id)).size).toBe(committed.bytes.size)
})

test("an unparseable other note keeps uncertain image dependencies when discarding", async () => {
  const { store, id } = await ready()
  const first = await image(id)
  await store.stageImage("photo.png", first.bytes, first.asset, [{ path: "a.mdx", content: "![A](photo.png)", baseRevision: null }, { path: "typing.mdx", content: "<Unfinished", baseRevision: null }])
  await store.discardDraft("a.mdx")
  expect((await store.read("photo.png")).draft).toBe(true)
})


test("a committed image with a lost save answer retains its asset and mutation on retry", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset, [], bytes)
  await store.saveImages(["photo.png"], [{ path: "note.md", content: "![Photo](photo.png)", expectedRevision: null }])
  const remote = server.remote(OWNER)
  let lose = true
  const sync = new ProjectSync(a.db, { ...remote, saveFiles: async (...args) => {
    const result = await remote.saveFiles(...args)
    if (lose) { lose = false; throw new RemoteError("network", "Lost save answer") }
    return result
  } }, a.partition)
  expect((await sync.sync(id)).status).toBe("offline")
  const pending = (await a.project(id))!.pending!.mutationId
  expect(server.saves()).toBe(1)
  expect((await sync.sync(id)).status).toBe("synced")
  expect(server.calls.filter(call => call.method === "saveFiles").map(call => call.args[1])).toEqual([pending, pending])
  expect(server.calls.filter(call => call.method === "uploadImage")).toHaveLength(1)
  expect(server.saves()).toBe(2)
  expect(server.projects.get(id)!.revision).toBe(1)
  expect(server.projects.get(id)!.savedResults.size).toBe(1)
  expect((await store.read("photo.png")).asset?.id).toBe(asset.id)
  expect((await a.project(id))?.syncError).toBeNull()
})

test("expired offline image staging rotates bytes and pending mutation before its atomic note save", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset, [], bytes)
  await store.saveImages(["photo.png"], [{ path: "note.md", content: "![Photo](photo.png)", expectedRevision: null }])
  const remote = server.remote(OWNER)
  let fail = true
  const sync = new ProjectSync(a.db, { ...remote, saveFiles: async (...args) => {
    if (fail) { fail = false; throw new RemoteError("network", "Offline before save") }
    return await remote.saveFiles(...args)
  } }, a.partition)
  expect((await sync.sync(id)).status).toBe("offline")
  const previousMutation = (await a.project(id))!.pending!.mutationId
  // The expiry collector removes only staging never referenced by a save.
  server.assets.delete(`${id}/${asset.id}`)
  expect((await sync.sync(id)).status).toBe("synced")
  const saved = await store.read("photo.png")
  expect(saved.asset?.id).not.toBe(asset.id)
  expect(saved.asset?.object_key).toBe(`${id}/${saved.asset!.id}/original`)
  expect(new Uint8Array(await (await store.readImage("photo.png")).arrayBuffer())).toEqual(PNG)
  const lastSave = server.calls.findLast(call => call.method === "saveFiles")!
  expect(lastSave.args[1]).not.toBe(previousMutation)
  expect(lastSave.args[2]).toContainEqual({ op: "asset", path: "photo.png", asset_id: saved.asset!.id })
  expect(server.content(id, "note.md")).toBe("![Photo](photo.png)")
  expect((await a.project(id))?.syncError).toBeNull()
})

test("a live interrupted upload retries its original identity without an access-lost error", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset, [], bytes)
  await store.saveImages(["photo.png"])
  const remote = server.remote(OWNER)
  let interrupt = true
  const sync = new ProjectSync(a.db, { ...remote,
    imageUploadStatus: async () => ({ status: "pending" as const }),
    uploadImage: async (...args) => {
      if (interrupt) { interrupt = false; throw new RemoteError("network", "Upload interrupted") }
      return await remote.uploadImage(...args)
    },
  }, a.partition)
  expect((await sync.sync(id)).status).toBe("offline")
  const pending = (await a.project(id))!.pending!.mutationId
  expect((await sync.sync(id)).status).toBe("synced")
  expect(server.calls.findLast(call => call.method === "saveFiles")!.args[1]).toBe(pending)
  expect((await store.read("photo.png")).asset?.id).toBe(asset.id)
  expect((await a.project(id))?.syncError).toBeNull()
})

test("a lost upload answer that expired before preview download recovers from its durable bytes", async () => {
  const { a, server, id, store } = await ready()
  const { bytes, asset } = await image(id)
  await store.stageImage("photo.png", bytes, asset, [], bytes)
  await store.saveImages(["photo.png"])
  server.loseResponses = 1
  expect((await a.sync.sync(id)).status).toBe("offline")
  const local = await a.db.transaction(a.partition, "readonly", tx => tx.getAsset(id, asset.id))
  expect(local?.uploaded).toBe(false)
  expect(local?.uploadAttempted).toBe(true)
  server.assets.delete(`${id}/${asset.id}`)
  expect((await a.sync.sync(id)).status).toBe("synced")
  expect((await store.read("photo.png")).asset?.id).not.toBe(asset.id)
  expect(new Uint8Array(await (await store.readImage("photo.png")).arrayBuffer())).toEqual(PNG)
  expect(server.saves()).toBe(1)
})


test("recovering expired staging preserves the base token of a newer replacement draft", async () => {
  const { a, server, id, store } = await ready()
  const original = await image(id)
  await store.stageImage("photo.png", original.bytes, original.asset, [], original.bytes)
  await store.saveImages(["photo.png"])
  const remote = server.remote(OWNER)
  let offline = true
  const sync = new ProjectSync(a.db, { ...remote, saveFiles: async (...args) => {
    if (offline) { offline = false; throw new RemoteError("network", "Offline before save") }
    return await remote.saveFiles(...args)
  } }, a.partition)
  expect((await sync.sync(id)).status).toBe("offline")
  const replacement = await image(id, true)
  await store.stageImage("photo.png", replacement.bytes, replacement.asset, [], replacement.bytes)
  server.assets.delete(`${id}/${original.asset.id}`)
  expect((await sync.sync(id)).status).toBe("synced")
  expect((await store.read("photo.png")).asset?.id).toBe(replacement.asset.id)
  expect((await store.read("photo.png")).draft).toBe(true)
  await store.saveImages(["photo.png"])
  expect((await sync.sync(id)).status).toBe("synced")
  expect(server.projects.get(id)!.files.get("photo.png")!.asset?.id).toBe(replacement.asset.id)
  expect(new Uint8Array(await (await store.readImage("photo.png")).arrayBuffer())).toEqual(new Uint8Array(await replacement.bytes.arrayBuffer()))
})

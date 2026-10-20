import { expect, test } from "bun:test"
import { ProjectFileStore } from "./fileStore"
import { ProjectSync } from "./sync"
import type { ProjectDatabase } from "./database"
import { device, FakeProjectServer, OWNER } from "./testing"
import { imageDigest, imageObjectKeys } from "../images/types"

const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), character => character.charCodeAt(0))
async function setup() {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Discard")
  const assetId = crypto.randomUUID()
  const bytes = new Blob([png], { type: "image/png" })
  const asset = { id: assetId, ...imageObjectKeys(id, assetId), media_type: "image/png" as const, byte_length: bytes.size, width: 1, height: 1, sha256: await imageDigest(png), preview_type: "image/png" as const, preview_byte_length: bytes.size }
  return { a, server, id, bytes, asset, store: a.files(id) }
}

test("Discard cleans an owned image after Undo already restored the saved note", async () => {
  const { a, id, bytes, asset, store } = await setup()
  await store.write("note.mdx", "Original text.", null)
  await store.stageImage("photo.png", bytes, { ...asset, draft_note: "note.mdx" })
  expect((await store.read("note.mdx")).draft).toBe(false)
  await store.discardDraft("note.mdx")
  expect((await store.listEntries()).files.map(file => file.path)).toEqual(["note.mdx"])
  expect(await a.db.transaction(a.partition, "readonly", tx => tx.listAssets(id))).toEqual([])
})

test("a reference added while planning Discard is rechecked before any image is removed", async () => {
  const { a, id, bytes, asset, store } = await setup()
  await store.stageImage("photo.png", bytes, asset, [{ path: "note.mdx", content: "![Photo](photo.png)", baseRevision: null }])
  let inject = true
  const racing: ProjectDatabase = {
    listProjects: partition => a.db.listProjects(partition),
    async transaction(partition, mode, work) {
      if (mode === "readwrite" && inject) {
        inject = false
        await a.db.transaction(partition, "readwrite", tx => tx.putFile({ partition, projectId: id, localId: crypto.randomUUID(), path: "other.md", base: null, content: null, batch: null, conflict: null, draft: { content: "![Still used](photo.png)", token: null } }))
      }
      return a.db.transaction(partition, mode, work)
    },
  }
  await new ProjectFileStore(racing, a.partition, id).discardDraft("note.mdx")
  expect((await store.listEntries()).files.map(file => file.path)).toEqual(["other.md", "photo.png"])
  expect((await store.readImage("photo.png")).size).toBe(bytes.size)
})

for (const target of ["note.md", "photo.png"]) test(`discarding ${target} preserves an in-flight image tombstone until acknowledgement`, async () => {
  const { a, server, id, bytes, asset, store } = await setup()
  await a.sync.sync(id)
  await store.stageImage("photo.png", bytes, asset, [], bytes)
  await store.saveImages(["photo.png"])
  // Use the same account as the device while pausing only the save response.
  const authenticated = server.remote(OWNER)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const sync = new ProjectSync(a.db, { ...authenticated, saveFiles: async (...args) => { entered(); await gate; return authenticated.saveFiles(...args) } }, a.partition)
  const sending = sync.sync(id)
  await started
  try {
    await store.delete("photo.png", (await store.read("photo.png")).revision)
    const replacementId = crypto.randomUUID()
    await store.stageImage("photo.png", bytes, { ...asset, id: replacementId, ...imageObjectKeys(id, replacementId) }, target === "note.md" ? [{ path: target, content: "![Replacement](photo.png)", baseRevision: null }] : [], bytes)
    await store.discardDraft(target)
    expect(await a.record(id, "photo.png")).toMatchObject({ content: null, base: null, draft: null })
  } finally { release() }
  expect((await sending).status).toBe("synced")
  expect((await store.listEntries()).files).toEqual([])
  expect(server.paths(id)).toEqual([])
})

test("a moved note's last synced source protects images relative to its original path", async () => {
  const { a, id, bytes, asset, store } = await setup()
  await store.write("old/ref.md", "![Protected](../photo.png)", null)
  await a.sync.sync(id)
  await store.stageImage("photo.png", bytes, asset, [{ path: "discard.md", content: "![Draft](photo.png)", baseRevision: null }])
  const before = await store.read("old/ref.md")
  await store.save([{ kind: "move", from: "old/ref.md", to: "new/deep/ref.md", content: "No current reference.", expectedRevision: before.revision }])
  await store.discardDraft("discard.md")
  expect((await store.read("photo.png")).draft).toBe(true)
  expect((await store.readImage("photo.png")).size).toBe(bytes.size)
})

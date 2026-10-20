import { expect, test } from "bun:test"
import { MemoryProjectDatabase } from "./database"
import { ProjectFileStore } from "./fileStore"
import { ProjectLibrary } from "./library"
import { partitionKey } from "./model"
import { RemoteError } from "./remote"
import { FakeProjectServer, OWNER } from "./testing"
import { imageDigest, imageObjectKeys } from "../images/types"

test("only explicit retry clears an invalid image upload stop, preserving saved bytes and newer note drafts", async () => {
  const db = new MemoryProjectDatabase()
  const server = new FakeProjectServer()
  const remote = server.remote(OWNER)
  const partition = partitionKey("https://example.supabase.co", OWNER)
  let broken = true, uploads = 0
  const library = new ProjectLibrary(db, { ...remote, uploadImage: async (...args) => {
    uploads++
    if (broken) throw new RemoteError("invalid", "The image thumbnail service is temporarily unavailable.")
    return remote.uploadImage(...args)
  } }, partition)
  const id = await library.create("Retry images")
  await library.syncProject(id)
  const store = new ProjectFileStore(db, partition, id)
  const data = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), character => character.charCodeAt(0))
  const bytes = new Blob([data], { type: "image/png" })
  const imageId = crypto.randomUUID()
  const asset = { id: imageId, ...imageObjectKeys(id, imageId), media_type: "image/png" as const, byte_length: bytes.size, width: 1, height: 1, sha256: await imageDigest(data), preview_type: "image/png" as const, preview_byte_length: bytes.size }
  const savedText = "![Photo](photo.png)\n"
  await store.stageImage("photo.png", bytes, asset, [{ path: "note.md", content: savedText, baseRevision: null }], bytes)
  await store.saveImages(["photo.png"], [{ path: "note.md", content: savedText, expectedRevision: null }])
  const note = await store.read("note.md")
  await store.persistDrafts([{ path: "note.md", content: `${savedText}\nStill writing.`, baseRevision: note.revision }])
  expect(await library.syncProject(id)).toMatchObject({ status: "stopped", reason: "invalid" })
  expect((await store.readImage("photo.png")).size).toBe(bytes.size)
  expect(await store.read("note.md")).toMatchObject({ content: `${savedText}\nStill writing.`, savedContent: savedText, draft: true })
  expect(server.content(id, "note.md")).toBeUndefined()
  expect(uploads).toBe(1)
  broken = false
  expect(await library.syncProject(id)).toMatchObject({ status: "stopped", reason: "invalid" })
  await library.syncWaiting()
  expect(uploads).toBe(1)
  expect((await db.transaction(partition, "readonly", tx => tx.getProject(id)))?.syncError).toBe("invalid")
  expect(await library.syncProject(id, true)).toMatchObject({ status: "synced" })
  expect(uploads).toBe(2)
  expect(server.content(id, "note.md")).toBe(savedText)
  expect(server.projects.get(id)!.files.get("photo.png")?.asset?.sha256).toBe(asset.sha256)
  expect(await store.read("note.md")).toMatchObject({ content: `${savedText}\nStill writing.`, draft: true })
  expect((await store.readImage("photo.png")).size).toBe(bytes.size)
})

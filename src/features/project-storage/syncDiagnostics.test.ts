import { expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"
import { IndexedProjectDatabase } from "./database"
import { ProjectFileStore } from "./fileStore"
import { LocalProject, partitionKey } from "./model"
import { RemoteError } from "./remote"
import { ProjectSync } from "./sync"
import { MAX_SYNC_ERROR_DETAIL, safeSyncErrorDetail, stoppedSyncMessage } from "./syncDiagnostics"
import { FakeProjectServer, OTHER, OWNER, put } from "./testing"

function diagnosticStorage() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
  }
}

test("only bounded actionable sync details survive, without remote credentials, paths or traces", () => {
  for (const detail of [
    "The image thumbnail service is temporarily unavailable.",
    "The image upload did not finish. Your draft is still on this device. Try again.",
    "Choose an image with at most 8 million pixels.",
    "The WebP image is incomplete.",
    "Animation exceeds 120 frames or 24 million decoded frame pixels.",
    "SVG text is limited to 4,000 characters per text node and 8,000 in total.",
    "SVG scripts and external resources are not supported.",
    "The SVG filter region is too large.",
    "This SVG filter resolution is too large.",
    "SVG geometry is too large or complex.",
    "The project owner has reached the 256 MiB image limit, including image history and pending uploads",
    "A project can hold at most 64 MiB of files",
  ]) expect(safeSyncErrorDetail(detail)).toBe(detail)
  for (const detail of [
    "The image thumbnail service is temporarily unavailable. Authorization: Bearer private-token",
    "The image could not be saved: https://example.test/storage/object?token=secret",
    "Authorization: Bearer secret",
    "{\"access_token\":\"secret\"}",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.private-signature",
    "Module not found: file:///var/tmp/sb-compile-edge-runtime/source/svgFont.json",
    "Error: decoding failed\n    at decode (file:///private/functions/images.ts:10:2)",
    "The SVG filter region is too large.\ntrace: private",
    "The SVG filter region is too large.\n",
    "x".repeat(MAX_SYNC_ERROR_DETAIL + 1),
  ]) expect(safeSyncErrorDetail(detail)).toBeNull()
  expect(safeSyncErrorDetail("Invalid path: https://user:password@example.test/image?token=private")).toBe("A file path is invalid.")
  expect(safeSyncErrorDetail("SVG element private-token is not supported. Use vector shapes without scripts or embedded content.")).toBe("This SVG contains an unsupported element. Use vector shapes without scripts or embedded content.")
  expect(stoppedSyncMessage("invalid", "https://example.test/?token=private")).toBe("The server refused these changes.")
  expect(stoppedSyncMessage("access-lost", "The WebP image is incomplete.")).toBe("You can no longer change this project. Your work stays on this device.")
})

test("a stopped diagnostic survives an IndexedDB reload and retry clears it before waiting for the project lock", async () => {
  const factory = new IDBFactory()
  const sidecar = diagnosticStorage()
  const partition = partitionKey("https://example.supabase.co", OWNER)
  const db = new IndexedProjectDatabase(factory, undefined, sidecar)
  const server = new FakeProjectServer()
  const remote = server.remote(OWNER)
  const detail = "SVG text is limited to 4,000 characters per text node and 8,000 in total."
  let broken = true, sends = 0
  const failingRemote = { ...remote, saveFiles: async (...args: Parameters<typeof remote.saveFiles>) => {
    sends++
    if (broken) throw new RemoteError("invalid", detail)
    return remote.saveFiles(...args)
  } }
  const sync = new ProjectSync(db, failingRemote, partition)
  const { id } = await sync.createProject("Preserved diagnostic")
  await sync.sync(id)
  const store = new ProjectFileStore(db, partition, id)
  await put(store, "note.md", "saved locally")
  const note = await store.read("note.md")
  await store.persistDrafts([{ path: "note.md", content: "a newer unsaved draft", baseRevision: note.revision }])
  const expected = { status: "stopped", reason: "invalid", message: `The server refused these changes: ${detail}` }
  expect(await sync.sync(id)).toMatchObject(expected)
  const reloaded = new IndexedProjectDatabase(factory, undefined, sidecar)
  expect(await reloaded.transaction(partition, "readonly", tx => tx.getProject(id))).toMatchObject({ syncError: "invalid", syncErrorDetail: detail })
  const restarted = new ProjectSync(reloaded, failingRemote, partition)
  expect(await restarted.sync(id)).toMatchObject(expected)
  expect(sends).toBe(1)
  expect(await reloaded.listProjects(partitionKey("https://example.supabase.co", OTHER))).toEqual([])

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const retrying = new ProjectSync(reloaded, failingRemote, partition, async (_name, work) => { await gate; return work() })
  const changed = new Promise<void>(resolve => retrying.subscribe(() => resolve()))
  broken = false
  const retry = retrying.retry(id)
  await changed
  expect(await reloaded.transaction(partition, "readonly", tx => tx.getProject(id))).toMatchObject({ syncError: null, syncErrorDetail: null })
  expect(sends).toBe(1)
  release()
  expect(await retry).toMatchObject({ status: "synced" })
  expect(sends).toBe(2)
  expect(server.content(id, "note.md")).toBe("saved locally")
  expect(await new ProjectFileStore(reloaded, partition, id).read("note.md")).toMatchObject({ content: "a newer unsaved draft", savedContent: "saved locally", draft: true })
  expect(await reloaded.transaction(partition, "readonly", tx => tx.getProject(id))).toMatchObject({ syncError: null, syncErrorDetail: null })
})

test("legacy stopped rows have a category fallback and unknown remote output never reaches stored diagnostics", async () => {
  const factory = new IDBFactory()
  const sidecar = diagnosticStorage()
  const partition = partitionKey("https://example.supabase.co", OWNER)
  const db = new IndexedProjectDatabase(factory, undefined, sidecar)
  const server = new FakeProjectServer()
  const remote = server.remote(OWNER)
  const sync = new ProjectSync(db, remote, partition)
  const { id } = await sync.createProject("Legacy record")
  await db.transaction(partition, "readwrite", async tx => {
    const project = (await tx.getProject(id))!
    expect(project.syncErrorDetail).toBeNull()
    await tx.putProject({ ...project, syncError: "invalid" })
  })
  const reloaded = new IndexedProjectDatabase(factory, undefined, sidecar)
  const restarted = new ProjectSync(reloaded, remote, partition)
  expect(await restarted.sync(id)).toMatchObject({ status: "stopped", message: "The server refused these changes." })
  const raw = "Module not found: https://example.test/?token=secret\n    at private/function.ts:20:4"
  const failed = new ProjectSync(reloaded, { ...remote, createProject: async () => { throw new RemoteError("invalid", raw) } }, partition)
  expect(await failed.retry(id)).toMatchObject({ status: "stopped", message: "The server refused these changes." })
  const stored = (await reloaded.transaction(partition, "readonly", tx => tx.getProject(id)))!
  expect(stored.syncErrorDetail).toBeNull()
  expect(JSON.stringify(stored)).not.toContain("secret")
  expect(LocalProject.safeParse({ ...stored, syncErrorDetail: raw }).success).toBe(false)
})

test("access changes replace old validation details and restoring access clears the stopped state", async () => {
  const db = new IndexedProjectDatabase(new IDBFactory(), undefined, diagnosticStorage())
  const partition = partitionKey("https://example.supabase.co", OWNER)
  const server = new FakeProjectServer()
  const remote = server.remote(OWNER)
  const sync = new ProjectSync(db, remote, partition)
  const { id } = await sync.createProject("Access changed")
  await sync.sync(id)
  await db.transaction(partition, "readwrite", async tx => tx.putProject({ ...(await tx.getProject(id))!, syncError: "invalid", syncErrorDetail: "The WebP image is incomplete." }))
  const summary = (await remote.listProjects())[0]
  const unavailable = new ProjectSync(db, { ...remote, listProjects: async () => [] }, partition)
  await unavailable.refresh()
  expect(await db.transaction(partition, "readonly", tx => tx.getProject(id))).toMatchObject({ syncError: "access-lost", syncErrorDetail: null })
  await sync.adopt(summary)
  expect(await db.transaction(partition, "readonly", tx => tx.getProject(id))).toMatchObject({ syncError: null, syncErrorDetail: null })
  await db.transaction(partition, "readwrite", async tx => tx.putProject({ ...(await tx.getProject(id))!, syncError: "archived", syncErrorDetail: "The WebP image is incomplete." }))
  await sync.adopt(summary)
  expect(await db.transaction(partition, "readonly", tx => tx.getProject(id))).toMatchObject({ syncError: null, syncErrorDetail: null })
})

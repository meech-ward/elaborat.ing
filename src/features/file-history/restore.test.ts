import { expect, test } from "bun:test"
import { imageDigest, imageObjectKeys, type ImageAsset } from "../images/types"
import { FakeProjectServer, OWNER, device, put } from "../project-storage/testing"
import { projectWorkspace } from "../workbench/workspaceStore"
import type { FileVersion } from "./remote"
import { HistoryRestoreError, restoreBlocked, restoreVersion } from "./restore"

async function ready(path = "notes/current.md") {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("History")
  const store = a.files(id)
  await put(store, path, "original")
  await a.sync.sync(id)
  const original = await store.read(path)
  await put(store, path, "current")
  await a.sync.sync(id)
  const file = await store.read(path)
  const version: FileVersion = {
    file_id: original.server!.id, version: original.server!.version, path: "notes/old-name.md",
    kind: "text", asset: null, deleted: false, author_id: OWNER, created_at: "2026-11-12T01:00:00Z",
  }
  const workspace = projectWorkspace(store, { afterSave() {}, subscribeSync: () => () => {} })
  return { server, a, id, store, workspace, file, version }
}

test("restore saves historical text at the current path with the current base version, retaining every historical save", async () => {
  const { server, a, id, store, workspace, file, version } = await ready()
  const before = structuredClone(server.projects.get(id)!.history)
  expect(await restoreVersion({ workspace, projectId: id, file, version, content: "original" })).toBe(file.path)
  expect((await store.read(file.path)).unsynced).toBe(true)
  await a.sync.sync(id)
  expect(server.content(id, file.path)).toBe("original")
  expect(server.content(id, version.path)).toBeUndefined()
  const save = server.calls.findLast(call => call.method === "saveFiles")!
  expect(save.args[2]).toEqual([{ op: "put", path: file.path, content: "original", base_version: file.server!.version }])
  expect(server.projects.get(id)!.history).toEqual([...before, { fileId: file.server!.id, version: file.server!.version + 1, deleted: false }])
})

test("a changed server copy becomes a normal sync conflict instead of being overwritten by restore", async () => {
  const { server, a, id, store, workspace, file, version } = await ready()
  await server.remote(OWNER).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file.path, content: "from another device", base_version: file.server!.version }])
  await restoreVersion({ workspace, projectId: id, file, version, content: "original" })
  await a.sync.sync(id)
  expect(server.content(id, file.path)).toBe("from another device")
  expect(await store.conflictCopies(file.path)).toEqual({ mine: "original", theirs: "from another device" })
})

test("restore refuses saved changes, drafts, a replacement identity, read-only access and no-op content", async () => {
  const { id, store, workspace, file, version } = await ready()
  expect(restoreBlocked(file, version, "This project is archived.")).toBe("This project is archived.")
  expect(restoreBlocked({ ...file, server: { id: crypto.randomUUID(), version: 2 } }, version)).toContain("no longer available")
  expect(restoreBlocked(file, { ...version, deleted: true })).toContain("deletion")
  await expect(restoreVersion({ workspace, projectId: id, file, version, content: "current" })).rejects.toThrow("already current")
  await expect(restoreVersion({ workspace, projectId: id, file, version, content: "original", isDirty: () => true })).rejects.toThrow("unsynced edits")
  await store.persistDrafts([{ path: file.path, content: "uncommitted words", baseRevision: file.revision }])
  await expect(restoreVersion({ workspace, projectId: id, file, version, content: "original" })).rejects.toThrow("unsynced edits")
  expect((await store.read(file.path)).content).toBe("uncommitted words")
  await store.discardDraft(file.path)
  await put(store, file.path, "saved meanwhile")
  await expect(restoreVersion({ workspace, projectId: id, file, version, content: "original" })).rejects.toThrow("changed while")
  expect((await store.read(file.path)).content).toBe("saved meanwhile")
})

test("a same-content newer server revision invalidates a captured restore even when its local content token is unchanged", async () => {
  const { server, a, id, store, workspace, file, version } = await ready()
  await server.remote(OWNER).saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file.path, content: "current", base_version: file.server!.version }])
  await a.sync.sync(id)
  expect((await store.read(file.path)).revision).toBe(file.revision)
  await expect(restoreVersion({ workspace, projectId: id, file, version, content: "original" })).rejects.toThrow("changed while")
  expect((await store.read(file.path)).content).toBe("current")
})

test("diagram restore saves source, regenerated canvas and sidecar in one revision-checked batch", async () => {
  const { a, id, store, workspace, file, version } = await ready("flow.d2")
  await put(store, "flow.excalidraw", "current canvas")
  await put(store, "flow.d2.json", "current sidecar")
  await a.sync.sync(id)
  const companions = await Promise.all([store.read("flow.excalidraw"), store.read("flow.d2.json")])
  let saves = 0
  const checkedWorkspace = {
    ...workspace,
    async save(changes: Parameters<typeof workspace.save>[0]) {
      saves++
      expect(changes).toEqual([
        { kind: "write", path: "flow.d2", content: "historical source", expectedRevision: file.revision, requireClean: true, expectedServer: file.server },
        { kind: "write", path: "flow.excalidraw", content: "regenerated canvas", expectedRevision: companions[0].revision, requireClean: true, expectedServer: companions[0].server },
        { kind: "write", path: "flow.d2.json", content: "new baseline", expectedRevision: companions[1].revision, requireClean: true, expectedServer: companions[1].server },
      ])
      return workspace.save(changes)
    },
  }
  await restoreVersion({
    workspace: checkedWorkspace, projectId: id, file, version, content: "historical source",
    prepareDiagram: async (source, nativePath, native, sidecar) => {
      expect(source).toBe("historical source")
      expect(nativePath).toBe("flow.excalidraw")
      expect(native?.savedContent).toBe("current canvas")
      expect(sidecar?.savedContent).toBe("current sidecar")
      return { native: "regenerated canvas", sidecar: "new baseline" }
    },
  })
  expect(saves).toBe(1)
  const records = await a.db.transaction(a.partition, "readonly", tx => tx.listFiles(id))
  expect(new Set(records.map(record => record.batch)).size).toBe(1)
  expect(records[0].batch).not.toBeNull()
})

test("diagram restore stops before saving if a companion changes during regeneration", async () => {
  const { a, id, store, workspace, file, version } = await ready("flow.d2")
  await put(store, "flow.excalidraw", "current canvas")
  await a.sync.sync(id)
  await expect(restoreVersion({
    workspace, projectId: id, file, version, content: "historical source",
    prepareDiagram: async () => {
      await store.persistDrafts([{ path: "flow.excalidraw", content: "new freehand", baseRevision: (await store.read("flow.excalidraw")).revision }])
      return { native: "regenerated canvas", sidecar: "new baseline" }
    },
  })).rejects.toThrow("unsynced edits")
  expect((await store.read(file.path)).content).toBe("current")
  expect((await store.read("flow.excalidraw")).content).toBe("new freehand")
  expect((await workspace.listEntries()).files.some(row => row.path === "flow.d2.json")).toBe(false)
})

test("diagram restore refuses a pending mounted companion before saving any file", async () => {
  const { a, id, store, workspace, file, version } = await ready("flow.d2")
  await put(store, "flow.excalidraw", "current canvas")
  await put(store, "flow.d2.json", "current sidecar")
  await a.sync.sync(id)
  let saved = false
  let prepared = false
  await expect(restoreVersion({
    workspace: { ...workspace, async save(changes) { saved = true; return workspace.save(changes) } },
    projectId: id, file, version, content: "historical source",
    // The source is clean, but a separate mounted companion is still settling
    // an edit that has not reached its persisted draft yet.
    isDirty: path => path === "flow.excalidraw",
    prepareDiagram: async () => { prepared = true; return { native: "regenerated canvas", sidecar: "new baseline" } },
  })).rejects.toThrow("unsynced edits")
  expect(prepared).toBe(false)
  expect(saved).toBe(false)
  expect((await store.read("flow.d2")).savedContent).toBe("current")
  expect((await store.read("flow.excalidraw")).savedContent).toBe("current canvas")
  expect((await store.read("flow.d2.json")).savedContent).toBe("current sidecar")
})

test("image restore caches immutable original and preview before an asset save and guards edits that arrive during download", async () => {
  const { id, workspace, file, version } = await ready("photo.png")
  const bytes = new Blob([Uint8Array.of(1, 2, 3)])
  const assetId = crypto.randomUUID()
  const asset: ImageAsset = {
    id: assetId, ...imageObjectKeys(id, assetId), media_type: "image/png", byte_length: bytes.size,
    width: 1, height: 1, sha256: await imageDigest(new Uint8Array(await bytes.arrayBuffer())),
    preview_type: "image/png", preview_byte_length: bytes.size, preview_width: 1, preview_height: 1,
  }
  const currentAsset = { ...asset, id: crypto.randomUUID() }
  const imageFile = { ...file, kind: "image" as const, asset: currentAsset }
  const imageVersion = { ...version, kind: "image" as const, asset }
  const calls: string[] = []
  let dirty = false
  const imageWorkspace = {
    ...workspace,
    async listEntries() { return { files: [imageFile], folders: [], directories: [] } },
    async read() { return { ...imageFile, content: "", savedContent: "" } },
    async cacheImage() { calls.push("cache") },
    async save() { calls.push("save"); return [] },
  }
  const downloadImage = async (_projectId: string, _asset: ImageAsset, preview?: boolean) => { calls.push(preview ? "preview" : "original"); return bytes }
  await restoreVersion({ workspace: imageWorkspace, projectId: id, file: imageFile, version: imageVersion, content: "", downloadImage })
  expect(calls).toEqual(["original", "preview", "cache", "save"])
  calls.length = 0
  await expect(restoreVersion({
    workspace: imageWorkspace, projectId: id, file: imageFile, version: imageVersion, content: "", isDirty: () => dirty,
    downloadImage: async (...args) => { const downloaded = await downloadImage(...args); dirty = true; return downloaded },
  })).rejects.toBeInstanceOf(HistoryRestoreError)
  expect(calls).not.toContain("save")
})

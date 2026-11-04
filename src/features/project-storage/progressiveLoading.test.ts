import { expect, test } from "bun:test"
import { createClient } from "@supabase/supabase-js"
import { SupabaseProjectRemote } from "./remote"
import { IDBFactory } from "fake-indexeddb"
import { IndexedProjectDatabase, MemoryProjectDatabase, type StorageTransaction } from "./database"
import { ProjectFileStore } from "./fileStore"
import { ProjectLibrary, offlineRemote } from "./library"
import { partitionKey, type ImageAsset } from "./model"
import { ProjectSync } from "./sync"
import { FakeProjectServer, OWNER, OTHER } from "./testing"
import { imageDigest, imageObjectKeys } from "../images/types"

const partition = partitionKey("https://example.supabase.co", OWNER)
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0))

async function fixture(images = 1) {
  const server = new FakeProjectServer()
  const remote = server.remote(OWNER)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Progressive")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "selected.md", content: "# Requested text" }, { op: "put", path: "unrelated.md", content: "Other text" }])
  const assets: ImageAsset[] = []
  for (let i = 0; i < images; i++) {
    const assetId = crypto.randomUUID()
    const bytes = new Blob([png], { type: "image/png" })
    const asset: ImageAsset = { id: assetId, ...imageObjectKeys(id, assetId), media_type: "image/png", byte_length: bytes.size, width: 1, height: 1, sha256: await imageDigest(png), preview_type: "image/png", preview_byte_length: bytes.size, preview_width: 1, preview_height: 1 }
    assets.push(await remote.uploadImage(id, asset, bytes))
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "asset", path: `images/${i}.png`, asset_id: asset.id }])
  }
  return { server, remote, id, assets, entry: (await remote.listProjects())[0] }
}

const record = (db: MemoryProjectDatabase, id: string) => db.transaction(partition, "readonly", tx => tx.getProject(id))

test("a cold open publishes the requested file before unrelated metadata and keeps a durable incomplete checkpoint", async () => {
  const { remote, id } = await fixture(0)
  const blocked = Promise.withResolvers<void>()
  const db = new MemoryProjectDatabase()
  const library = new ProjectLibrary(db, { ...remote, changedFiles: async (...args) => { await blocked.promise; return remote.changedFiles(...args) } }, partition)
  expect(await library.open(id, "selected.md")).toBe(true)
  expect((await new ProjectFileStore(db, partition, id).read("selected.md")).content).toBe("# Requested text")
  expect(await record(db, id)).toMatchObject({ revision: 0, partial: { metadata: false } })
  expect(library.getState().entries[0]).toMatchObject({ status: "preparing" })
  await expect(new ProjectFileStore(db, partition, id).snapshot()).rejects.toThrow("not downloaded completely")
  await expect(new ProjectFileStore(db, partitionKey("https://example.supabase.co", OTHER), id).read("selected.md")).rejects.toThrow("not on this device")
  blocked.resolve()
  expect(await library.openComplete(id)).toBe(true)
  expect(await record(db, id)).not.toHaveProperty("partial")
  expect((await new ProjectFileStore(db, partition, id).snapshot()).files).toHaveLength(2)
})

test("each verified image is published while another image is blocked, with at most three image workers", async () => {
  const { remote, id, assets, entry } = await fixture(5)
  const blocked = Promise.withResolvers<void>()
  const firstReady = Promise.withResolvers<void>()
  const db = new MemoryProjectDatabase()
  let active = 0
  let maximum = 0
  const pending = new Map<string, number>()
  const sync = new ProjectSync(db, { ...remote, downloadImage: async (project, asset, preview) => {
    if (!pending.has(asset.id)) { active++; maximum = Math.max(maximum, active) }
    pending.set(asset.id, (pending.get(asset.id) ?? 0) + 1)
    try {
      if (asset.id === assets[0].id) await blocked.promise
      return await remote.downloadImage(project, asset, preview)
    } finally {
      const left = pending.get(asset.id)! - 1
      if (left === 0) { pending.delete(asset.id); active-- } else pending.set(asset.id, left)
    }
  } }, partition)
  sync.subscribe(() => { void db.transaction(partition, "readonly", tx => tx.getAsset(id, assets[1].id)).then(asset => { if (asset) firstReady.resolve() }) })
  const download = sync.download(entry)
  await firstReady.promise
  expect(await record(db, id)).toMatchObject({ revision: 0, partial: { metadata: true } })
  expect(await db.transaction(partition, "readonly", tx => tx.getAsset(id, assets[0].id))).toBeNull()
  expect(maximum).toBeLessThanOrEqual(3)
  blocked.resolve()
  await download
  expect(await record(db, id)).toMatchObject({ revision: entry.revision })
  expect(await record(db, id)).not.toHaveProperty("partial")
})

test("interrupted preparation reopens the selected draft offline and resumes without changing its immutable image identity", async () => {
  const { remote, id, entry, assets } = await fixture()
  const blocked = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const controller = new AbortController()
  const db = new MemoryProjectDatabase()
  const sync = new ProjectSync(db, { ...remote, downloadImage: async (...args) => { await blocked.promise; return remote.downloadImage(...args) } }, partition)
  const download = sync.download(entry, { path: "selected.md", signal: controller.signal, ready: () => ready.resolve() })
  await ready.promise
  const store = new ProjectFileStore(db, partition, id)
  const saved = await store.read("selected.md")
  await store.persistDrafts([{ path: "selected.md", content: "Recovered typing", baseRevision: saved.revision }])
  controller.abort()
  blocked.resolve()
  await expect(download).rejects.toThrow()
  expect((await record(db, id))?.revision).toBe(0)
  const offline = new ProjectLibrary(db, offlineRemote, partition)
  expect(await offline.open(id, "selected.md")).toBe(true)
  expect((await store.read("selected.md")).content).toBe("Recovered typing")
  await expect(store.snapshot()).rejects.toThrow("not downloaded completely")
  const online = new ProjectLibrary(db, remote, partition)
  expect(await online.openComplete(id)).toBe(true)
  expect((await store.read("selected.md")).content).toBe("Recovered typing")
  expect((await store.read("images/0.png")).asset?.id).toBe(assets[0].id)
  expect((await record(db, id))?.revision).toBe(entry.revision)
})

class QuotaDatabase extends MemoryProjectDatabase {
  failAssets = true
  override transaction<T>(partition: string, mode: "readonly" | "readwrite", work: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return super.transaction(partition, mode, tx => work({ ...tx, putAsset: asset => {
      if (this.failAssets) throw new DOMException("Storage quota exceeded", "QuotaExceededError")
      return tx.putAsset(asset)
    } }))
  }
}

test("a quota failure retains readable text and the previous checkpoint, and a retry completes after storage is available", async () => {
  const { remote, id, entry } = await fixture()
  const db = new QuotaDatabase()
  const sync = new ProjectSync(db, remote, partition)
  await expect(sync.download(entry)).rejects.toThrow("Storage quota")
  expect((await new ProjectFileStore(db, partition, id).read("selected.md")).content).toBe("# Requested text")
  expect(await record(db, id)).toMatchObject({ revision: 0, partial: { metadata: true } })
  db.failAssets = false
  await sync.download(entry)
  expect((await record(db, id))?.revision).toBe(entry.revision)
})

test("lost access during background preparation never advances the offline checkpoint", async () => {
  const { server, remote, id, entry } = await fixture()
  const db = new MemoryProjectDatabase()
  const sync = new ProjectSync(db, { ...remote, listProjects: async () => [] }, partition)
  await expect(sync.download(entry)).rejects.toThrow("access to this project ended")
  expect(await record(db, id)).toMatchObject({ revision: 0, syncError: "access-lost", partial: { metadata: true } })
  expect(server.projects.has(id)).toBe(true)
})

test("IndexedDB v3 preserves stored drafts, marks legacy revision-zero remote copies partial and refuses older writers", async () => {
  const factory = new IDBFactory()
  const name = crypto.randomUUID()
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore("projects", { keyPath: ["partition", "id"] }).createIndex("partition", "partition")
      const files = db.createObjectStore("files", { keyPath: ["partition", "projectId", "path"] })
      files.createIndex("project", ["partition", "projectId"]); files.createIndex("baseId", ["partition", "projectId", "base.id"])
      db.createObjectStore("folders", { keyPath: ["partition", "projectId", "path"] }).createIndex("project", ["partition", "projectId"])
      db.createObjectStore("assets", { keyPath: ["partition", "projectId", "id"] }).createIndex("project", ["partition", "projectId"])
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const id = crypto.randomUUID()
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction(["projects", "files"], "readwrite")
    tx.objectStore("projects").put({ partition, id, title: "Preserved", pendingTitle: null, role: "owner", revision: 0, created: true, archivedAt: null, syncError: null, pending: null })
    tx.objectStore("files").put({ partition, projectId: id, localId: crypto.randomUUID(), path: "draft.md", base: null, content: null, batch: null, draft: { content: "Saved draft survives upgrade", token: null }, conflict: null })
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
  })
  legacy.onversionchange = () => legacy.close()
  const db = new IndexedProjectDatabase(factory, name)
  expect((await new ProjectFileStore(db, partition, id).read("draft.md")).content).toBe("Saved draft survives upgrade")
  expect((await db.listProjects(partition))[0]).toMatchObject({ partial: { revision: 0, metadata: false } })
  await expect(new ProjectFileStore(db, partition, id).snapshot()).rejects.toThrow("not downloaded completely")
  await expect(new Promise<void>((resolve, reject) => {
    const old = factory.open(name, 2)
    old.onerror = () => reject(old.error)
    old.onsuccess = () => { old.result.close(); resolve() }
  })).rejects.toMatchObject({ name: "VersionError" })
})

test("a blocked upgrade asks for other tabs to close and retries after the old connection leaves", async () => {
  const factory = new IDBFactory()
  const name = crypto.randomUUID()
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, 2)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  const db = new IndexedProjectDatabase(factory, name)
  await expect(db.listProjects(partition)).rejects.toThrow("Close other elaborat.ing tabs")
  old.close()
  // The abandoned blocked request aborts before schema creation. A fresh open
  // creates all stores and does not inherit a rejected connection promise.
  expect(await db.listProjects(partition)).toEqual([])
})

test("an adapter invalidated by a later schema upgrade keeps its stored drafts and gives actionable reload guidance", async () => {
  const factory = new IDBFactory()
  const name = crypto.randomUUID()
  const db = new IndexedProjectDatabase(factory, name)
  const sync = new ProjectSync(db, new FakeProjectServer().remote(OWNER), partition)
  const { id } = await sync.createProject("Stored draft")
  const store = new ProjectFileStore(db, partition, id)
  await store.persistDrafts([{ path: "note.md", content: "Durably saved before upgrade", baseRevision: null }])
  const newer = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, 4)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  await expect(store.persistDrafts([{ path: "note.md", content: "Refused obsolete writer", baseRevision: null }])).rejects.toThrow("Reload this tab before saving again")
  const saved = await new Promise<{ draft: { content: string } }>((resolve, reject) => {
    const read = newer.transaction("files").objectStore("files").get([partition, id, "note.md"])
    read.onsuccess = () => resolve(read.result)
    read.onerror = () => reject(read.error)
  })
  expect(saved.draft.content).toBe("Durably saved before upgrade")
  newer.close()
})

test("a failed cold-open offline preparation reports a safe quota explanation and explicit retry clears it", async () => {
  const { remote, id } = await fixture()
  const db = new QuotaDatabase()
  const library = new ProjectLibrary(db, remote, partition)
  const failed = Promise.withResolvers<void>()
  const stop = library.subscribe(() => {
    if (library.getState().entries.find(entry => entry.id === id)?.preparation?.error) failed.resolve()
  })
  expect(await library.open(id, "selected.md")).toBe(true)
  await failed.promise
  expect(library.getState().entries.find(entry => entry.id === id)?.preparation?.error).toBe("Offline preparation paused because this device is out of storage. Free some space, then retry.")
  expect((await new ProjectFileStore(db, partition, id).read("selected.md")).content).toBe("# Requested text")
  db.failAssets = false
  expect(await library.openComplete(id)).toBe(true)
  expect(library.getState().entries.find(entry => entry.id === id)?.preparation).toBeUndefined()
  stop()
})

test("authenticated metadata and both image requests carry the cancellation signal through the official SDK", async () => {
  const { id, assets, entry } = await fixture()
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const signals: AbortSignal[] = []
  const client = createClient("https://example.supabase.co", "public-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) { reject(new Error("Missing request cancellation signal")); return }
      signals.push(signal)
      if (signals.length === 7) started.resolve()
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })) as typeof fetch },
  })
  const remote = new SupabaseProjectRemote(client)
  const requests = [
    remote.listProjects(controller.signal),
    remote.requestedFile(id, "selected.md", entry.revision, controller.signal),
    remote.changedFiles(id, 0, entry.revision, controller.signal),
    remote.deletedFiles(id, 0, entry.revision, controller.signal),
    remote.folders(id, controller.signal),
    remote.downloadImage(id, assets[0], false, controller.signal),
    remote.downloadImage(id, assets[0], true, controller.signal),
  ]
  await started.promise
  controller.abort()
  const outcomes = await Promise.allSettled(requests)
  expect(signals).toHaveLength(7)
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect(outcomes.every(outcome => outcome.status === "rejected" && outcome.reason.name === "AbortError")).toBe(true)
})

test("opening an image prepares only that image before the unrelated metadata arrives", async () => {
  const { remote, id, assets } = await fixture(2)
  const blocked = Promise.withResolvers<void>()
  const requested: string[] = []
  const db = new MemoryProjectDatabase()
  const library = new ProjectLibrary(db, {
    ...remote,
    changedFiles: async (...args) => { await blocked.promise; return remote.changedFiles(...args) },
    downloadImage: async (...args) => { requested.push(args[1].id); return remote.downloadImage(...args) },
  }, partition)
  expect(await library.open(id, "images/1.png")).toBe(true)
  expect(new Set(requested)).toEqual(new Set([assets[1].id]))
  expect((await new ProjectFileStore(db, partition, id).readImage("images/1.png")).size).toBe(png.length)
  expect(await record(db, id)).toMatchObject({ revision: 0, partial: { metadata: false } })
  blocked.resolve()
  await library.openComplete(id)
})

test("a second requested path bypasses a healthy blocked bulk pull and canceled paths never publish late", async () => {
  const { remote, id } = await fixture(0)
  const bulk = Promise.withResolvers<void>()
  const late = Promise.withResolvers<void>()
  const reached = Promise.withResolvers<void>()
  const db = new MemoryProjectDatabase()
  const library = new ProjectLibrary(db, {
    ...remote,
    changedFiles: async (...args) => { await bulk.promise; return remote.changedFiles(...args) },
    requestedFile: async (...args) => {
      if (args[1] === "unrelated.md" && args[3]) { reached.resolve(); await late.promise }
      return remote.requestedFile!(...args)
    },
  }, partition)
  expect(await library.open(id, "selected.md")).toBe(true)
  const controller = new AbortController()
  const canceled = library.requestFile(id, "unrelated.md", controller.signal)
  await reached.promise
  controller.abort()
  late.resolve()
  await expect(canceled).rejects.toThrow()
  await expect(new ProjectFileStore(db, partition, id).read("unrelated.md")).rejects.toThrow("not in this project")
  await library.load()
  let notifications = 0
  const stop = library.subscribe(() => { notifications++ })
  const previousState = library.getState()
  await library.requestFile(id, "missing.excalidraw")
  expect(notifications).toBe(0)
  expect(library.getState()).toBe(previousState)
  await library.requestFile(id, "unrelated.md")
  expect(notifications).toBeGreaterThan(0)
  expect(library.getState()).not.toBe(previousState)
  expect((await new ProjectFileStore(db, partition, id).read("unrelated.md")).content).toBe("Other text")
  expect(await record(db, id)).toMatchObject({ revision: 0, partial: { metadata: false } })
  stop()
  bulk.resolve()
  await library.openComplete(id)
})

test("a cold download queued behind another tab is durably partial before it gets the lock", async () => {
  const { remote, id, entry } = await fixture(0)
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const db = new MemoryProjectDatabase()
  const sync = new ProjectSync(db, remote, partition, async (_name, work) => { reached.resolve(); await release.promise; return work() })
  const download = sync.download(entry, { signal: controller.signal })
  await reached.promise
  expect(await record(db, id)).toMatchObject({ revision: 0, partial: { revision: entry.revision, metadata: false } })
  await expect(new ProjectFileStore(db, partition, id).snapshot()).rejects.toThrow("not downloaded completely")
  controller.abort()
  release.resolve()
  await expect(download).rejects.toThrow()
  expect(await record(db, id)).toHaveProperty("partial")
  expect(await new ProjectLibrary(db, remote, partition).openComplete(id)).toBe(true)
})

test("reopening a different target after a canceled cold wait retries instead of inheriting the canceled promise", async () => {
  const { remote, id } = await fixture(0)
  const entered = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  const controller = new AbortController()
  const db = new MemoryProjectDatabase()
  const library = new ProjectLibrary(db, {
    ...remote,
    requestedFile: async (...args) => {
      if (args[1] === "selected.md") { entered.resolve(); await blocked.promise; args[3]?.throwIfAborted() }
      return remote.requestedFile!(...args)
    },
  }, partition)
  const original = library.open(id, "selected.md", controller.signal)
  await entered.promise
  controller.abort()
  const reopened = library.open(id, "unrelated.md")
  blocked.resolve()
  await expect(original).rejects.toThrow()
  expect(await reopened).toBe(true)
  expect((await new ProjectFileStore(db, partition, id).read("unrelated.md")).content).toBe("Other text")
  await library.openComplete(id)
})

test("selecting a known pending image starts it ahead of unrelated blocked image workers and reuses healthy transfers", async () => {
  const { remote, id, assets, entry } = await fixture(5)
  const blocked = Promise.withResolvers<void>()
  const metadata = Promise.withResolvers<void>()
  const firstStarted = Promise.withResolvers<void>()
  const calls = new Map<string, number>()
  const db = new MemoryProjectDatabase()
  const sync = new ProjectSync(db, { ...remote, downloadImage: async (...args) => {
    const asset = args[1]
    calls.set(asset.id, (calls.get(asset.id) ?? 0) + 1)
    if (asset.id === assets[0].id) firstStarted.resolve()
    if (assets.slice(0, 3).some(candidate => candidate.id === asset.id)) await blocked.promise
    return remote.downloadImage(...args)
  } }, partition)
  const download = sync.download(entry, { ready: () => metadata.resolve() })
  await metadata.promise
  await firstStarted.promise
  expect(calls.has(assets[4].id)).toBe(false)
  await sync.requestFile(id, "images/4.png")
  expect((await new ProjectFileStore(db, partition, id).readImage("images/4.png")).size).toBe(png.length)
  const joining = sync.requestFile(id, "images/0.png")
  blocked.resolve()
  await joining
  await download
  expect(calls.get(assets[0].id)).toBe(2)
  expect(calls.get(assets[4].id)).toBe(2)
})

test("a queued view sync canceled during departure starts no new remote preparation", async () => {
  const { remote, id, entry } = await fixture(0)
  const db = new MemoryProjectDatabase()
  await new ProjectSync(db, remote, partition).download(entry)
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  let lists = 0
  const sync = new ProjectSync(db, { ...remote, listProjects: async (...args) => { lists++; return remote.listProjects(...args) } }, partition,
    async (_name, work) => { reached.resolve(); await release.promise; return work() })
  const queued = sync.sync(id, controller.signal)
  await reached.promise
  controller.abort()
  release.resolve()
  await expect(queued).rejects.toThrow()
  expect(lists).toBe(0)
  expect((await record(db, id))?.revision).toBe(entry.revision)
})

test("departure lets an already-sent save commit and acknowledge before canceling its optional pull", async () => {
  const { remote, id, entry, server } = await fixture(0)
  const db = new MemoryProjectDatabase()
  await new ProjectSync(db, remote, partition).download(entry)
  const store = new ProjectFileStore(db, partition, id)
  const base = await store.read("selected.md")
  await store.write("selected.md", "Authoritative saved edit", base.revision)
  const sent = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  let lists = 0
  const sync = new ProjectSync(db, { ...remote,
    saveFiles: async (...args) => { sent.resolve(); await release.promise; return remote.saveFiles(...args) },
    listProjects: async (...args) => { lists++; return remote.listProjects(...args) },
  }, partition)
  const saving = sync.sync(id, controller.signal)
  await sent.promise
  controller.abort()
  release.resolve()
  await expect(saving).rejects.toThrow()
  expect(server.content(id, "selected.md")).toBe("Authoritative saved edit")
  expect((await record(db, id))?.pending).toBeNull()
  expect((await store.read("selected.md")).unsynced).toBe(false)
  expect(lists).toBe(0)
})

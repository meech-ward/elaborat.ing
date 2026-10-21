import { expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"
import { z } from "zod/mini"
import { deleteAccountProjects, IndexedProjectDatabase } from "./database"
import { ProjectFileStore } from "./fileStore"
import { ensureLocalProject, LOCAL_PARTITION, LOCAL_PROJECT_ID, moveLocalProject } from "./localProject"
import { LocalProject, type LocalFile } from "./model"
import { ProjectDiagnosticStorage, type SyncDiagnosticStorage } from "./syncDiagnosticStorage"

const detail = "The image thumbnail service is temporarily unavailable."
const project = (partition = "one", id = crypto.randomUUID()): LocalProject => ({
  partition, id, title: "A private title", pendingTitle: null, role: "owner", revision: 0,
  created: false, archivedAt: null, syncError: "invalid", syncErrorDetail: detail, pending: null,
})
function sidecar() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}
async function rawConnection(factory: IDBFactory) { return request(factory.open("elaborating", 2)) }
const legacyProject = z.omit(LocalProject, { syncErrorDetail: true })

// An older app tab's database adapter, with its existing strict project parser.
function legacyDatabase(raw: IDBDatabase) {
  return {
    listProjects: async (partition: string) => (await request(raw.transaction("projects").objectStore("projects").index("partition").getAll(partition))).map(row => legacyProject.parse(row)),
    transaction: async <T>(_partition: string, _mode: "readonly" | "readwrite", work: (tx: { getProject(id: string): Promise<LocalProject | null>; getFile(projectId: string, path: string): Promise<LocalFile | null>; putFile(file: LocalFile): Promise<void> }) => Promise<T>) => {
      const tx = raw.transaction(["projects", "files"], "readwrite")
      const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
      const result = await work({
        getProject: async id => { const row = await request(tx.objectStore("projects").get([_partition, id])); return row ? legacyProject.parse(row) : null },
        getFile: async (id, path) => await request(tx.objectStore("files").get([_partition, id, path])) ?? null,
        putFile: async file => { await request(tx.objectStore("files").put(file)) },
      })
      await done
      return result
    },
  }
}

test("raw v2 projects stay readable and an older tab can persist a draft after a new tab records its diagnostic", async () => {
  const factory = new IDBFactory(), storage = sidecar()
  const db = new IndexedProjectDatabase(factory, undefined, storage)
  const p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  const raw = await rawConnection(factory)
  const row = await request(raw.transaction("projects").objectStore("projects").get([p.partition, p.id]))
  expect(Object.hasOwn(row, "syncErrorDetail")).toBe(false)
  expect(legacyProject.safeParse(row).success).toBe(true)
  const legacy = legacyDatabase(raw)
  // This operation needs only the old transaction methods implemented above.
  const store = new ProjectFileStore(legacy as never, p.partition, p.id)
  await store.persistDrafts([{ path: "note.md", content: "a draft from the older tab", baseRevision: null }])
  expect(await new ProjectFileStore(db, p.partition, p.id).read("note.md")).toMatchObject({ content: "a draft from the older tab", draft: true })
  const reopened = new IndexedProjectDatabase(factory, undefined, storage)
  expect((await reopened.listProjects(p.partition))[0].syncErrorDetail).toBe(detail)
  expect([...storage.values.values()].join()).not.toContain(p.title)
})

test("aborted transactions neither publish nor remove diagnostics", async () => {
  const storage = sidecar(), db = new IndexedProjectDatabase(new IDBFactory(), undefined, storage), p = project()
  await expect(db.transaction(p.partition, "readwrite", async tx => { await tx.putProject(p); throw new Error("abort") })).rejects.toThrow("abort")
  expect(storage.values.size).toBe(0)
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  await expect(db.transaction(p.partition, "readwrite", async tx => { await tx.putProject({ ...p, syncError: null, syncErrorDetail: null }); throw new Error("abort") })).rejects.toThrow("abort")
  expect((await db.listProjects(p.partition))[0].syncErrorDetail).toBe(detail)
})

test("observing a legacy retry clears its old diagnostic and it cannot reappear on another same-category stop", async () => {
  const factory = new IDBFactory(), storage = sidecar(), db = new IndexedProjectDatabase(factory, undefined, storage), p = project()
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  const raw = await rawConnection(factory)
  const legacyRow = { ...p }
  delete legacyRow.syncErrorDetail
  const legacy = legacyProject.parse(legacyRow)
  const write = async (value: LocalProject) => { await request(raw.transaction("projects", "readwrite").objectStore("projects").put(value)) }
  await write({ ...legacy, syncError: null })
  expect((await db.listProjects(p.partition))[0].syncErrorDetail).toBeNull()
  expect(storage.values.size).toBe(0)
  await write({ ...legacy, syncError: "invalid" })
  expect((await db.listProjects(p.partition))[0].syncErrorDetail).toBeNull()
  // Snapshot changes also hide and clear explanations without a category change.
  await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
  await write({ ...legacy, revision: 1 })
  expect((await db.listProjects(p.partition))[0].syncErrorDetail).toBeNull()
})

test("diagnostics stay account-scoped and project/account deletion clears their sidecars", async () => {
  const storage = sidecar(), db = new IndexedProjectDatabase(new IDBFactory(), undefined, storage), a = project(), b = project("two")
  await db.transaction(a.partition, "readwrite", tx => tx.putProject(a))
  await db.transaction(b.partition, "readwrite", tx => tx.putProject(b))
  expect(new ProjectDiagnosticStorage(storage).read(b.partition, a.id)).toBeNull()
  expect(await db.transaction(b.partition, "readonly", tx => tx.getProject(a.id))).toBeNull()
  await db.transaction(a.partition, "readwrite", tx => tx.deleteProject(a.id))
  expect(storage.values.size).toBe(1)
  expect((await db.listProjects(b.partition))[0].syncErrorDetail).toBe(detail)
  await deleteAccountProjects(db, b.partition)
  expect(storage.values.size).toBe(0)
})

test("moving the local project into an account clears the old diagnostic and carries no stopped detail", async () => {
  const storage = sidecar(), db = new IndexedProjectDatabase(new IDBFactory(), undefined, storage)
  await ensureLocalProject(db, async () => {})
  const store = new ProjectFileStore(db, LOCAL_PARTITION, LOCAL_PROJECT_ID)
  await store.write("note.md", "Local work", null)
  await db.transaction(LOCAL_PARTITION, "readwrite", async tx => tx.putProject({ ...(await tx.getProject(LOCAL_PROJECT_ID))!, syncError: "invalid", syncErrorDetail: detail }))
  expect(storage.values.size).toBe(1)
  const id = await moveLocalProject(db, "account")
  expect(id).not.toBeNull()
  expect(storage.values.size).toBe(0)
  expect((await db.listProjects("account"))[0]).toMatchObject({ syncError: null, syncErrorDetail: null })
})

test("unavailable or quota-limited diagnostic storage cannot block durable saves or retry clearing", async () => {
  for (const failing of ["getItem", "setItem", "removeItem"] as const) {
    const memory = sidecar()
    const storage: SyncDiagnosticStorage = { ...memory, [failing]: () => { throw new Error("storage unavailable") } }
    const db = new IndexedProjectDatabase(new IDBFactory(), undefined, storage), p = project()
    await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
    const store = new ProjectFileStore(db, p.partition, p.id)
    await store.write("note.md", "saved despite sidecar failure", null)
    await db.transaction(p.partition, "readwrite", tx => tx.putProject({ ...p, syncError: null, syncErrorDetail: null }))
    expect(await store.read("note.md")).toMatchObject({ savedContent: "saved despite sidecar failure" })
    expect((await db.listProjects(p.partition))[0].syncErrorDetail).toBeNull()
  }
})


test("untrusted, oversized and mismatched sidecars are ignored and cleared after a successful read", async () => {
  for (const change of [
    (record: object) => JSON.stringify({ ...record, detail: "Authorization: Bearer private-token" }),
    (record: object) => JSON.stringify({ ...record, version: 2 }),
    (record: object) => JSON.stringify({ ...record, revision: 1 }),
    (record: object) => JSON.stringify({ ...record, extra: "https://example.test/?token=private" }),
    () => "{bad json",
    () => " ".repeat(1025),
  ]) {
    const storage = sidecar(), db = new IndexedProjectDatabase(new IDBFactory(), undefined, storage), p = project()
    await db.transaction(p.partition, "readwrite", tx => tx.putProject(p))
    const [key, value] = [...storage.values][0]
    storage.values.set(key, change(JSON.parse(value)))
    expect((await db.listProjects(p.partition))[0].syncErrorDetail).toBeNull()
    expect(storage.values.size).toBe(0)
  }
})

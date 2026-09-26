import { expect, test } from "bun:test"
import { MemoryProjectDatabase, type ProjectDatabase, type StorageTransaction } from "./database"
import { FileStoreError, LocalConflictError, ProjectFileStore } from "./fileStore"
import { contentToken } from "./model"
import { device, FakeProjectServer, put } from "./testing"

async function setup() {
  const a = device(new FakeProjectServer())
  const project = await a.sync.createProject("Notes")
  return { a, id: project.id, store: a.files(project.id) }
}

test("a save is checked against the revision it was based on", async () => {
  const { a, id, store } = await setup()
  const first = await store.write("a.md", "one", null)
  expect(first.revision).toBe(await contentToken("one"))
  await store.write("a.md", "two", first.revision)
  await expect(store.write("a.md", "three", first.revision)).rejects.toBeInstanceOf(LocalConflictError)
  await expect(store.write("a.md", "new", null)).rejects.toBeInstanceOf(LocalConflictError)
  expect((await store.read("a.md")).content).toBe("two")
  expect((await a.record(id, "a.md"))?.batch).toBeNull()
})

test("changes saved together share a batch and fail together", async () => {
  const { a, id, store } = await setup()
  await store.writeBatch([
    { path: "x.md", content: "x", expectedRevision: null },
    { path: "y.md", content: "y", expectedRevision: null },
  ])
  const [x, y] = [await a.record(id, "x.md"), await a.record(id, "y.md")]
  expect(x?.batch).not.toBeNull()
  expect(x?.batch).toBe(y?.batch ?? "")

  const stale = await contentToken("stale")
  await expect(
    store.save([
      { kind: "write", path: "z.md", content: "z", expectedRevision: null },
      { kind: "write", path: "x.md", content: "x2", expectedRevision: stale },
    ]),
  ).rejects.toBeInstanceOf(LocalConflictError)
  expect(await a.record(id, "z.md")).toBeNull()
})

test("moves refuse to lose unsaved edits or overwrite a file", async () => {
  const { store } = await setup()
  const a = await store.write("a.md", "a", null)
  await store.write("b.md", "b", null)
  await expect(store.move("a.md", "b.md", a.revision)).rejects.toThrow("already exists")
  await store.persistDrafts([{ path: "a.md", content: "unsaved", baseRevision: a.revision }])
  await expect(store.move("a.md", "c.md", a.revision)).rejects.toThrow("unsaved edits")
  await store.discardDraft("a.md")
  const moved = await store.move("a.md", "c.md", a.revision, "a, edited while moving")
  expect(moved.path).toBe("c.md")
  expect((await store.read("c.md")).content).toBe("a, edited while moving")
  await expect(store.read("a.md")).rejects.toBeInstanceOf(FileStoreError)
})

test("deleting a file never synced forgets it; deleting a synced file keeps the deletion to send", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Notes")
  const store = a.files(id)
  const local = await store.write("local.md", "x", null)
  await store.delete("local.md", local.revision)
  expect(await a.record(id, "local.md")).toBeNull()

  const synced = await store.write("synced.md", "x", null)
  await a.sync.sync(id)
  await store.delete("synced.md", synced.revision)
  expect((await a.record(id, "synced.md"))?.content).toBeNull()
  expect((await store.listEntries()).files).toEqual([])

  // Saving at the path again replaces the pending deletion with an edit.
  await store.write("synced.md", "back", null)
  expect((await a.record(id, "synced.md"))?.base?.content).toBe("x")
})

test("a file and a folder cannot share a path, and a file cannot contain anything", async () => {
  const { store } = await setup()
  await store.write("a", "file", null)
  await expect(store.write("a/b.md", "x", null)).rejects.toThrow("is a file")
  await store.write("d/e.md", "x", null)
  await expect(store.write("d", "x", null)).rejects.toThrow("already contains")
  await store.createDirectory("empty")
  await expect(store.write("empty", "x", null)).rejects.toThrow("is a folder")
  await expect(store.createDirectory("a")).rejects.toThrow("is a file")
  expect((await store.listEntries()).directories).toEqual(["d", "empty"])
  await store.removeDirectory("empty")
  expect((await store.listEntries()).directories).toEqual(["d"])
})

test("within one save, each change sees the ones before it", async () => {
  const { store } = await setup()
  const write = (path: string, content = "x") => ({ kind: "write" as const, path, content, expectedRevision: null })
  await expect(store.save([write("a"), write("a/b.md")])).rejects.toThrow("a is a file, so it cannot contain a/b.md.")
  await expect(store.save([write("d/e.md"), write("d")])).rejects.toThrow("d already contains other files.")
  expect((await store.listEntries()).files).toEqual([])

  // A move or a delete earlier in the save frees its path for later changes.
  const x = await store.write("x", "file", null)
  const gone = await store.write("gone", "file", null)
  await store.save([
    { kind: "move", from: "x", to: "y", expectedRevision: x.revision },
    write("x/z.md"),
    { kind: "delete", path: "gone", expectedRevision: gone.revision },
    write("gone/kept.md"),
  ])
  expect((await store.listEntries()).files.map((file) => file.path).sort()).toEqual(["gone/kept.md", "x/z.md", "y"])
})

test("several folders are created together, or none is", async () => {
  const { store } = await setup()
  await store.write("a", "file", null)
  await expect(store.createDirectories(["fine", "a"])).rejects.toThrow("a is a file.")
  await expect(store.createDirectories(["fine", "a/inside"])).rejects.toThrow("a is a file, so it cannot contain a/inside.")
  expect((await store.listEntries()).directories).toEqual([])
  await store.createDirectories(["one", "two/three"])
  expect((await store.listEntries()).directories).toEqual(["one", "two/three"])
})

/** Counts write transactions, to see how many writes a burst of drafts takes. */
class CountingDatabase extends MemoryProjectDatabase {
  writes = 0
  override transaction<T>(partition: string, mode: "readonly" | "readwrite", work: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    if (mode === "readwrite") this.writes++
    return super.transaction(partition, mode, work)
  }
}

test("a save that moves files also makes and removes folders, all or nothing", async () => {
  const { a, id, store } = await setup()
  await store.createDirectories(["docs", "docs/empty"])
  const note = await store.write("docs/a.md", "a", null)
  const folders = () => a.db.transaction(a.partition, "readonly", (tx) => tx.listFolders(id))

  // A file in the way of a new folder refuses the whole save.
  await put(store, "taken", "a file")
  await expect(
    store.save([
      { kind: "move", from: "docs/a.md", to: "notes/a.md", expectedRevision: note.revision },
      { kind: "mkdir", path: "taken" },
    ]),
  ).rejects.toThrow("taken is a file.")
  expect(await a.paths(id)).toEqual(["docs/a.md", "taken"])
  expect((await folders()).map((folder) => folder.path)).toEqual(["docs", "docs/empty"])

  await store.save([
    { kind: "move", from: "docs/a.md", to: "notes/a.md", expectedRevision: note.revision },
    { kind: "mkdir", path: "notes" },
    { kind: "mkdir", path: "notes/empty" },
    { kind: "rmdir", path: "docs/empty" },
    { kind: "rmdir", path: "docs" },
  ])
  expect((await store.listEntries()).directories).toEqual(["notes", "notes/empty"])
  // The folders share the file's batch, so sync sends them together.
  const batch = (await a.record(id, "notes/a.md"))!.batch
  expect(batch).not.toBeNull()
  expect((await folders()).map((folder) => [folder.path, folder.local, folder.batch])).toEqual([
    ["notes", true, batch],
    ["notes/empty", true, batch],
  ])
  await expect(store.save([{ kind: "rmdir", path: "docs" }])).rejects.toThrow("There is no folder docs.")
})

test("drafts made faster than they are written coalesce, and the latest text is kept", async () => {
  const db = new CountingDatabase()
  const a = device(new FakeProjectServer(), undefined, db)
  const project = await a.sync.createProject("Notes")
  const store = a.files(project.id)
  const saved = await store.write("a.md", "saved", null)
  const before = db.writes
  // Five keystrokes, each asking for its draft to be kept before the first is written.
  const kept = ["savedd", "saveddr", "saveddra", "saveddraf", "saveddraft"].map((content) =>
    store.persistDrafts([{ path: "a.md", content, baseRevision: saved.revision }]),
  )
  await Promise.all(kept)
  expect((await store.read("a.md")).content).toBe("saveddraft")
  expect(db.writes - before).toBeLessThanOrEqual(2)
  // Another file's draft made meanwhile is kept too.
  await Promise.all([
    store.persistDrafts([{ path: "a.md", content: "saveddrafts", baseRevision: saved.revision }]),
    store.persistDrafts([{ path: "b.md", content: "other", baseRevision: null }]),
  ])
  expect([(await store.read("a.md")).content, (await store.read("b.md")).content]).toEqual(["saveddrafts", "other"])
})

test("drafts are kept apart from the saved copy until saved or discarded", async () => {
  const { store } = await setup()
  const saved = await store.write("a.md", "saved", null)
  await store.persistDrafts([{ path: "a.md", content: "typing", baseRevision: saved.revision }])
  await store.persistDrafts([{ path: "new.md", content: "brand new", baseRevision: null }])
  await store.flushDrafts()
  const a = await store.read("a.md")
  expect([a.content, a.savedContent, a.draft, a.revision]).toEqual(["typing", "saved", true, saved.revision])
  expect((await store.read("new.md")).savedContent).toBeNull()

  await store.write("a.md", "typing", saved.revision)
  expect((await store.read("a.md")).draft).toBe(false)
  await store.discardDraft("new.md")
  expect((await store.listEntries()).files.map((file) => file.path)).toEqual(["a.md"])
})

test("viewers and archived projects cannot change files", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Notes")
  await put(a.files(id), "a.md", "x")
  await a.db.transaction(a.partition, "readwrite", async (tx) => {
    const project = (await tx.getProject(id))!
    await tx.putProject({ ...project, role: "viewer" })
  })
  await expect(put(a.files(id), "b.md", "x")).rejects.toThrow("view this project")
  await a.db.transaction(a.partition, "readwrite", async (tx) => {
    const project = (await tx.getProject(id))!
    await tx.putProject({ ...project, role: "owner", archivedAt: new Date().toISOString() })
  })
  await expect(put(a.files(id), "b.md", "x")).rejects.toThrow("archived")
})

test("a save that fails to store keeps the old bytes and reports no save", async () => {
  const inner = new MemoryProjectDatabase()
  let failWrites = false
  const db: ProjectDatabase = {
    listProjects: (partition) => inner.listProjects(partition),
    transaction: (partition, mode, work) =>
      inner.transaction(partition, mode, (tx) =>
        work({
          ...tx,
          putFile: async (file) => {
            if (failWrites) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
            return tx.putFile(file)
          },
        }),
      ),
  }
  const a = device(new FakeProjectServer(), undefined, db)
  const { id } = await a.sync.createProject("Notes")
  const store = new ProjectFileStore(db, a.partition, id)
  const saved = await store.write("a.md", "old", null)
  let notices = 0
  store.subscribe(() => notices++)
  failWrites = true
  await expect(store.write("a.md", "new", saved.revision)).rejects.toThrow("quota")
  failWrites = false
  expect(notices).toBe(0)
  expect(await store.read("a.md")).toMatchObject({ content: "old", revision: saved.revision })
})

test("a later save supersedes an older draft, and undoing to the saved bytes drops the draft", async () => {
  const { store } = await setup()
  const saved = await store.write("a.md", "v1", null)
  await store.persistDrafts([{ path: "a.md", content: "v1 and some", baseRevision: saved.revision }])
  await store.write("a.md", "v1 and some more", saved.revision)
  expect((await store.read("a.md")).draft).toBe(false)

  const current = await store.read("a.md")
  await store.persistDrafts([{ path: "a.md", content: "changed", baseRevision: current.revision }])
  await store.persistDrafts([{ path: "a.md", content: "v1 and some more", baseRevision: current.revision }])
  expect((await store.read("a.md")).draft).toBe(false)
})

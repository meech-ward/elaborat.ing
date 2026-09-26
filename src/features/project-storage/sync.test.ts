import { expect, test } from "bun:test"
import { OTHER, OWNER, device, FakeProjectServer, put, shared } from "./testing"

test("a project made offline reaches the server with one save per local save", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Notes")
  const store = a.files(id)
  await put(store, "a.md", "one")
  await store.writeBatch([
    { path: "b.md", content: "two", expectedRevision: null },
    { path: "c.md", content: "three", expectedRevision: null },
  ])
  server.offline = true
  expect((await a.sync.sync(id)).status).toBe("offline")
  server.offline = false
  expect(await a.sync.sync(id)).toEqual({ status: "synced", projectId: id })

  expect(server.paths(id)).toEqual(["a.md", "b.md", "c.md"])
  expect(server.saves()).toBe(2)
  const files = server.projects.get(id)!.files
  expect(files.get("b.md")!.version).toBe(files.get("c.md")!.version)
  expect((await a.project(id))?.revision).toBe(server.projects.get(id)!.revision)
  expect((await store.listEntries()).files.every((file) => !file.unsynced)).toBe(true)
})

test("a save whose answer was lost is retried with the same mutation id and applied once", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Notes")
  await put(a.files(id), "a.md", "one")
  await a.sync.sync(id)
  const before = server.projects.get(id)!.revision

  await put(a.files(id), "a.md", "two")
  server.loseResponses = 1
  expect((await a.sync.sync(id)).status).toBe("offline")
  expect((await a.project(id))?.pending).not.toBeNull()
  expect(await a.sync.sync(id)).toEqual({ status: "synced", projectId: id })

  const saves = server.calls.filter((call) => call.method === "saveFiles").slice(-2)
  expect(saves[0].args[1]).toBe(saves[1].args[1])
  expect(server.projects.get(id)!.revision).toBe(before + 1)
  expect(server.content(id, "a.md")).toBe("two")
})

test("one stale file conflicts without holding back the others", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "base", "b.md": "base" })
  await put(a.files(id), "a.md", "from A")
  await a.sync.sync(id)
  await put(b.files(id), "a.md", "from B")
  await put(b.files(id), "b.md", "from B")

  expect((await b.sync.sync(id)).status).toBe("synced")
  expect(server.content(id, "a.md")).toBe("from A")
  expect(server.content(id, "b.md")).toBe("from B")
  const conflicted = await b.record(id, "a.md")
  expect(conflicted?.conflict?.current?.content).toBe("from A")
  expect(conflicted?.content).toBe("from B")

  await b.sync.resolve(id, "a.md", "mine")
  await b.sync.sync(id)
  expect(server.content(id, "a.md")).toBe("from B")
})

test("taking theirs drops this device's change; keeping both saves it beside theirs", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "base", "n/b.md": "base" })
  await put(a.files(id), "a.md", "A")
  await put(a.files(id), "n/b.md", "A")
  await a.sync.sync(id)
  await put(b.files(id), "a.md", "B")
  await put(b.files(id), "n/b.md", "B")
  await b.sync.sync(id)

  await b.sync.resolve(id, "a.md", "theirs")
  await b.sync.resolve(id, "n/b.md", "both")
  expect(await b.sync.sync(id)).toEqual({ status: "synced", projectId: id })
  expect(server.paths(id)).toEqual(["a.md", "n/b (my copy).md", "n/b.md"])
  expect(server.content(id, "n/b (my copy).md")).toBe("B")
  expect((await b.files(id).read("a.md")).content).toBe("A")
  expect((await b.files(id).read("n/b.md")).content).toBe("A")
})

test("a pull brings new, changed, moved and deleted files", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "a", "b.md": "b", "c.md": "c" })
  const store = a.files(id)
  await put(store, "a.md", "a2")
  await store.move("b.md", "d/b.md", (await store.read("b.md")).revision)
  await store.delete("c.md", (await store.read("c.md")).revision)
  await put(store, "e.md", "e")
  await a.sync.sync(id)

  await b.sync.sync(id)
  expect(await b.paths(id)).toEqual(["a.md", "d/b.md", "e.md"])
  expect((await b.files(id).read("a.md")).content).toBe("a2")
  expect((await b.files(id).read("d/b.md")).content).toBe("b")
  expect((await b.project(id))?.revision).toBe(server.projects.get(id)!.revision)
})

test("a skipped file holds the revision, so reverting it locally still converges", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "base" })
  const held = (await b.project(id))!.revision
  await put(a.files(id), "a.md", "from A")
  await a.sync.sync(id)

  await put(b.files(id), "a.md", "typing")
  await b.sync.refresh()
  expect((await b.files(id).read("a.md")).content).toBe("typing")
  expect((await b.project(id))?.revision).toBe(held)

  // Back to the old content: clean again, but on an old base. The held revision brings the update.
  await put(b.files(id), "a.md", "base")
  await b.sync.refresh()
  expect((await b.files(id).read("a.md")).content).toBe("from A")
  expect((await b.project(id))?.revision).toBe(server.projects.get(id)!.revision)
})

test("files from one D2 diagram sync together even when saved apart", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Diagrams")
  await put(a.files(id), "flow.d2", "a -> b")
  await put(a.files(id), "flow.excalidraw", "{}")
  await put(a.files(id), "notes.md", "x")
  await a.sync.sync(id)
  const saves = server.calls.filter((call) => call.method === "saveFiles").map((call) => (call.args[2] as unknown[]).length)
  expect(saves.sort()).toEqual([1, 2])
})

test("renaming a file and reusing its old path syncs, keeping the file's identity", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Notes")
  await put(a.files(id), "a.md", "old")
  await a.sync.sync(id)
  const original = server.projects.get(id)!.files.get("a.md")!.id
  const store = a.files(id)
  await store.move("a.md", "b.md", (await store.read("a.md")).revision)
  await put(store, "a.md", "new")
  expect(await a.sync.sync(id)).toEqual({ status: "synced", projectId: id })
  expect(server.projects.get(id)!.files.get("b.md")!.id).toBe(original)
  expect(server.content(id, "a.md")).toBe("new")
})

test("a path taken on the server marks the file, and moving the file clears it", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "a" })
  await put(a.files(id), "notes/x.md", "x")
  await a.sync.sync(id)

  await put(b.files(id), "notes", "a file named notes")
  expect((await b.sync.sync(id)).status).toBe("synced")
  expect((await b.record(id, "notes"))?.conflict?.pathTaken).toBe(true)
  await expect(b.sync.resolve(id, "notes", "mine")).rejects.toThrow("taken")

  const store = b.files(id)
  await store.move("notes", "notes.md", (await store.read("notes")).revision)
  expect((await b.record(id, "notes.md"))?.conflict).toBeNull()
  await b.sync.sync(id)
  expect(server.paths(id)).toEqual(["a.md", "notes.md", "notes/x.md"])
})

test("an empty folder whose path is taken on the server is dropped", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "a" })
  await put(a.files(id), "docs", "a file")
  await a.sync.sync(id)
  await b.files(id).createDirectory("docs")
  await b.files(id).createDirectory("kept")
  expect((await b.sync.sync(id)).status).toBe("synced")
  expect([...server.projects.get(id)!.folders]).toEqual(["kept"])
  expect((await b.db.transaction(b.partition, "readonly", (tx) => tx.listFolders(id))).map((folder) => folder.path)).toEqual(["kept"])
  expect(await b.paths(id)).toEqual(["a.md", "docs"])
})

test("a project id someone else holds is replaced, keeping every file", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const local = await a.sync.createProject("Mine")
  await server.remote(OTHER).createProject(local.id, "Theirs")
  await put(a.files(local.id), "a.md", "mine")
  const events: unknown[] = []
  a.sync.subscribe((event) => events.push(event))

  const outcome = await a.sync.sync(local.id)
  expect(outcome.status).toBe("synced")
  expect(outcome.projectId).not.toBe(local.id)
  expect(events).toContainEqual({ type: "rekeyed", projectId: local.id, newId: outcome.projectId })
  expect(server.content(outcome.projectId, "a.md")).toBe("mine")
  expect(server.paths(local.id)).toEqual([])
  expect(await a.project(local.id)).toBeNull()
})

test("a retried create keeps a later rename to send", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("One")
  server.loseResponses = 1
  expect((await a.sync.sync(id)).status).toBe("offline")
  await a.sync.rename(id, "Two")
  expect((await a.sync.sync(id)).status).toBe("synced")
  expect(server.projects.get(id)!.title).toBe("Two")
  expect(await a.project(id)).toMatchObject({ title: "Two", pendingTitle: null, created: true })
})

test("losing access stops sync and keeps the batch for when access returns", async () => {
  const server = new FakeProjectServer()
  const owner = device(server, OWNER)
  const editor = device(server, OTHER)
  const project = await owner.sync.createProject("Shared")
  await put(owner.files(project.id), "a.md", "a")
  await owner.sync.sync(project.id)
  server.share(project.id, OTHER, "editor")
  await editor.sync.download((await editor.sync.refresh())[0])

  await put(editor.files(project.id), "a.md", "edited")
  server.projects.get(project.id)!.members.delete(OTHER)
  const stopped = await editor.sync.sync(project.id)
  expect(stopped).toMatchObject({ status: "stopped", reason: "access-lost" })
  const kept = (await editor.project(project.id))!.pending
  expect(kept).not.toBeNull()

  server.share(project.id, OTHER, "editor")
  await editor.sync.refresh()
  expect((await editor.project(project.id))?.syncError).toBeNull()
  expect((await editor.sync.sync(project.id)).status).toBe("synced")
  expect(server.calls.filter((call) => call.method === "saveFiles").at(-1)!.args[1]).toBe(kept!.mutationId)
  expect(server.content(project.id, "a.md")).toBe("edited")
})

test("an archived project stops sync until it is unarchived", async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject("Notes")
  await put(a.files(id), "a.md", "a")
  await a.sync.sync(id)
  await put(a.files(id), "a.md", "edited")
  server.projects.get(id)!.archivedAt = new Date().toISOString()
  expect(await a.sync.sync(id)).toMatchObject({ status: "stopped", reason: "archived" })
  expect(await a.project(id)).toMatchObject({ pending: null, syncError: "archived" })

  server.projects.get(id)!.archivedAt = null
  await a.sync.refresh()
  expect((await a.sync.sync(id)).status).toBe("synced")
  expect(server.content(id, "a.md")).toBe("edited")
})

test("two files swapping paths on the server are pulled", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "A", "b.md": "B" })
  const remote = server.remote(OWNER)
  const version = (path: string) => server.projects.get(id)!.files.get(path)!.version
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "move", path: "a.md", to: "tmp.md", base_version: version("a.md") }])
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "move", path: "b.md", to: "a.md", base_version: version("b.md") }])
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "move", path: "tmp.md", to: "b.md", base_version: version("tmp.md") }])

  await b.sync.refresh()
  expect((await b.files(id).read("a.md")).content).toBe("B")
  expect((await b.files(id).read("b.md")).content).toBe("A")
  expect((await b.project(id))?.revision).toBe(server.projects.get(id)!.revision)
})

test("a pulled file waits while a file with local changes holds its path", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "original" })
  const store = a.files(id)
  await store.move("a.md", "b.md", (await store.read("a.md")).revision)
  await put(store, "a.md", "new file")
  await a.sync.sync(id)

  await put(b.files(id), "a.md", "B's edit")
  await b.sync.refresh()
  expect(await b.paths(id)).toEqual(["a.md"])
  expect((await b.files(id).read("a.md")).content).toBe("B's edit")

  await b.sync.sync(id)
  expect((await b.record(id, "a.md"))?.conflict?.current?.content).toBe("new file")
  await b.sync.resolve(id, "a.md", "theirs")
  await b.sync.sync(id)
  expect(await b.paths(id)).toEqual(["a.md", "b.md"])
  expect((await b.files(id).read("a.md")).content).toBe("new file")
  expect((await b.files(id).read("b.md")).content).toBe("original")
  expect((await b.project(id))?.revision).toBe(server.projects.get(id)!.revision)
})

test("an unsaved draft at a path the server fills stays on top", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "a" })
  await b.files(id).persistDrafts([{ path: "n.md", content: "draft", baseRevision: null }])
  await put(a.files(id), "n.md", "server")
  await a.sync.sync(id)
  await b.sync.refresh()
  const n = await b.files(id).read("n.md")
  expect([n.content, n.savedContent, n.draft]).toEqual(["draft", "server", true])
})

test("nothing is pulled while a save is in flight", async () => {
  const server = new FakeProjectServer()
  const [a, b] = [device(server), device(server)]
  const id = await shared(server, a, b, { "a.md": "a", "b.md": "b" })
  await put(b.files(id), "a.md", "B")
  server.loseResponses = 1
  expect((await b.sync.sync(id)).status).toBe("offline")
  await put(a.files(id), "b.md", "A")
  await a.sync.sync(id)

  await b.sync.refresh()
  expect((await b.files(id).read("b.md")).content).toBe("b")
  expect(await b.sync.sync(id)).toEqual({ status: "synced", projectId: id })
  expect((await b.files(id).read("b.md")).content).toBe("A")
  expect((await b.record(id, "a.md"))?.conflict).toBeNull()
  expect((await b.project(id))?.revision).toBe(server.projects.get(id)!.revision)
})

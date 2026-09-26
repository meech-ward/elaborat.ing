import { expect, test } from "bun:test"
import { MemoryProjectDatabase } from "./database"
import { ProjectLibrary, offlineRemote } from "./library"
import { partitionKey } from "./model"
import { FakeProjectServer, OTHER, OWNER, put } from "./testing"
import { ProjectFileStore } from "./fileStore"

const partition = partitionKey("https://example.supabase.co", OWNER)

function library(server: FakeProjectServer, db = new MemoryProjectDatabase()) {
  return { db, library: new ProjectLibrary(db, server.remote(OWNER), partition) }
}

test("the list shows projects on this device and on the server, with their state", async () => {
  const server = new FakeProjectServer()
  const elsewhere = library(server)
  const shared = await elsewhere.library.create("On the server")
  await elsewhere.library.syncProject(shared)

  const { db, library: here } = library(server)
  const local = await here.create("Only here")
  await here.refresh()
  expect(here.getState().entries.map(({ title, status }) => ({ title, status }))).toEqual([
    { title: "On the server", status: "not-downloaded" },
    { title: "Only here", status: "unsynced" },
  ])

  expect(await here.open(shared)).toBe(true)
  await here.syncProject(local)
  expect(here.getState().entries.map(({ title, status }) => ({ title, status }))).toEqual([
    { title: "On the server", status: "synced" },
    { title: "Only here", status: "synced" },
  ])

  await put(new ProjectFileStore(db, partition, local), "a.md", "edited here")
  await here.load()
  expect(here.getState().entries.find((entry) => entry.id === local)?.status).toBe("unsynced")
})

test("opening a project neither side has says so", async () => {
  const { library: here } = library(new FakeProjectServer())
  expect(await here.open(crypto.randomUUID())).toBe(false)
})

test("without a connection, projects on this device still open, and new ones wait to sync", async () => {
  const server = new FakeProjectServer()
  const db = new MemoryProjectDatabase()
  const online = new ProjectLibrary(db, server.remote(OWNER), partition)
  const id = await online.create("Notes")
  await online.syncProject(id)

  const offline = new ProjectLibrary(db, offlineRemote, partition)
  await offline.refresh()
  expect(offline.getState().offline).toBe(true)
  expect(await offline.open(id)).toBe(true)
  const created = await offline.create("Written offline")
  expect((await offline.syncProject(created)).status).toBe("offline")
  expect(offline.getState().entries.find((entry) => entry.id === created)?.status).toBe("unsynced")
})

test("a project whose sync stopped says why", async () => {
  const server = new FakeProjectServer()
  const { db, library: here } = library(server)
  const id = await here.create("Notes")
  await here.syncProject(id)
  await put(new ProjectFileStore(db, partition, id), "a.md", "x")
  server.projects.get(id)!.archivedAt = new Date().toISOString()
  await here.syncProject(id)
  expect(here.getState().entries[0]).toMatchObject({ status: "stopped", stopped: "archived" })
})

test("projects with changes waiting are sent once the connection returns", async () => {
  const server = new FakeProjectServer()
  const { library: here } = library(server)
  server.offline = true
  const first = await here.create("First")
  const second = await here.create("Second")
  await here.refresh()
  expect(here.getState().offline).toBe(true)
  server.offline = false
  await here.refresh()
  await here.syncWaiting()
  expect([...server.projects.keys()].sort()).toEqual([first, second].sort())
  expect(here.getState().entries.every((entry) => entry.status === "synced")).toBe(true)
})

/** A project OTHER owns, with one file. */
async function othersProject(server: FakeProjectServer, title: string) {
  const owner = server.remote(OTHER)
  const id = crypto.randomUUID()
  await owner.createProject(id, title)
  await owner.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: "notes/a.md", content: "a" }])
  return id
}

test("an accepted invitation joins the list and downloads the project", async () => {
  const server = new FakeProjectServer()
  const id = await othersProject(server, "Their notes")
  server.invite(id, OWNER, "editor")
  const { db, library: here } = library(server)
  await here.refresh()
  await here.refreshInvitations()
  expect(here.getState().entries).toEqual([])
  expect(here.getState().invitations).toEqual([{ projectId: id, title: "Their notes", role: "editor" }])

  await here.accept(id)
  expect(here.getState().invitations).toEqual([])
  expect(here.getState().entries.map(({ id, title, role, status }) => ({ id, title, role, status }))).toEqual([
    { id, title: "Their notes", role: "editor", status: "synced" },
  ])
  expect((await new ProjectFileStore(db, partition, id).read("notes/a.md")).content).toBe("a")
})

test("leaving a shared project removes it from the server's list and from this device", async () => {
  const server = new FakeProjectServer()
  const id = await othersProject(server, "Their notes")
  server.share(id, OWNER, "editor")
  const { db, library: here } = library(server)
  await here.refresh()
  await here.open(id)

  await here.leave(id)
  expect(here.getState().entries).toEqual([])
  expect(await db.listProjects(partition)).toEqual([])
  expect(await db.transaction(partition, "readonly", (tx) => tx.listFiles(id))).toEqual([])
  await here.refresh()
  expect(here.getState().entries).toEqual([])
})

test("leaving is refused, naming the files, while this device has changes the server does not", async () => {
  const server = new FakeProjectServer()
  const id = await othersProject(server, "Their notes")
  server.share(id, OWNER, "editor")
  const { db, library: here } = library(server)
  await here.refresh()
  await here.open(id)
  const store = new ProjectFileStore(db, partition, id)
  await put(store, "notes/a.md", "edited here")
  await store.persistDrafts([{ path: "notes/b.md", content: "unsaved", baseRevision: null }])

  const problem = "Not left: Their notes has changes on this device that have not synced (notes/a.md, notes/b.md). Sync them first, so nothing is lost."
  expect(await here.leaveProblem(id)).toBe(problem)
  await expect(here.leave(id)).rejects.toThrow(problem)
  expect((await server.remote(OWNER).listProjects()).map((project) => project.id)).toEqual([id])
  expect((await store.read("notes/a.md")).content).toBe("edited here")
})

test("leaving needs a connection", async () => {
  const server = new FakeProjectServer()
  const id = await othersProject(server, "Their notes")
  server.share(id, OWNER, "viewer")
  const { library: here } = library(server)
  await here.refresh()
  await here.open(id)
  server.offline = true
  await expect(here.leave(id)).rejects.toThrow("Leaving a project needs a connection. Try again when you are online.")
  expect(here.getState().entries.map((entry) => entry.id)).toEqual([id])
})

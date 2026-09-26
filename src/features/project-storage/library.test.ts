import { expect, test } from "bun:test"
import { MemoryProjectDatabase } from "./database"
import { ProjectLibrary, offlineRemote } from "./library"
import { partitionKey } from "./model"
import { FakeProjectServer, OWNER, put } from "./testing"
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

import { expect, test } from "bun:test"
import { MemoryProjectDatabase } from "./database"
import { ProjectFileStore } from "./fileStore"
import { ensureLocalProject, LOCAL_PARTITION, LOCAL_PROJECT_ID, moveLocalProject } from "./localProject"
import { device, FakeProjectServer, put } from "./testing"

const local = (db: MemoryProjectDatabase) => new ProjectFileStore(db, LOCAL_PARTITION, LOCAL_PROJECT_ID)

test("the local project is made once, and asks the browser to keep its storage that first time", async () => {
  const db = new MemoryProjectDatabase()
  let asked = 0
  const persist = async () => void asked++
  await ensureLocalProject(db, persist)
  await put(local(db), "a.md", "kept")
  await ensureLocalProject(db, persist)
  expect(asked).toBe(1)
  expect((await db.listProjects(LOCAL_PARTITION)).map((project) => project.title)).toEqual(["Local project"])
  expect((await local(db).read("a.md")).content).toBe("kept")
})

test("signing in moves the local project into the account once, and sync uploads it as Local project", async () => {
  const server = new FakeProjectServer()
  const db = new MemoryProjectDatabase()
  const account = device(server, undefined, db)
  const existing = await account.sync.createProject("Earlier")
  await account.sync.sync(existing.id)
  await ensureLocalProject(db, async () => {})
  await put(local(db), "notes/a.md", "# Written before signing up")

  const id = await moveLocalProject(db, account.partition)
  expect(id).not.toBeNull()
  expect(await moveLocalProject(db, account.partition)).toBeNull()
  expect(await db.listProjects(LOCAL_PARTITION)).toEqual([])

  expect((await account.sync.sync(id!)).status).toBe("synced")
  expect([...server.projects.values()].map((project) => project.title).sort()).toEqual(["Earlier", "Local project"])
  expect(server.content(id!, "notes/a.md")).toBe("# Written before signing up")
})

test("an empty local project is not uploaded, only cleared", async () => {
  const db = new MemoryProjectDatabase()
  const account = device(new FakeProjectServer(), undefined, db)
  await ensureLocalProject(db, async () => {})
  expect(await moveLocalProject(db, account.partition)).toBeNull()
  expect(await db.listProjects(account.partition)).toEqual([])
  expect(await db.listProjects(LOCAL_PARTITION)).toEqual([])
})

const welcome = [
  { path: "welcome.mdx", content: '# Welcome\n\n<Diagram src="flow.d2" />\n' },
  { path: "flow.d2", content: "a -> b\n" },
]

test("a new local project starts with the starter files, and deleting them does not bring them back", async () => {
  const db = new MemoryProjectDatabase()
  let loads = 0
  const starter = async () => (loads++, welcome)
  expect(await ensureLocalProject(db, async () => {}, starter)).toBe(true)
  expect((await local(db).listEntries()).files.map((file) => file.path)).toEqual(["flow.d2", "welcome.mdx"])
  expect((await local(db).read("welcome.mdx")).content).toBe(welcome[0].content)

  for (const { path } of welcome) await local(db).delete(path, (await local(db).read(path)).revision)
  expect(await ensureLocalProject(db, async () => {}, starter)).toBe(false)
  expect((await local(db).listEntries()).files).toEqual([])
  expect(loads).toBe(1)
})

test("on signing in, a local project with only the untouched starter files is removed, not uploaded", async () => {
  const db = new MemoryProjectDatabase()
  const account = device(new FakeProjectServer(), undefined, db)
  const starter = async () => welcome
  await ensureLocalProject(db, async () => {}, starter)
  expect(await moveLocalProject(db, account.partition, undefined, starter)).toBeNull()
  expect(await db.listProjects(account.partition)).toEqual([])
  expect(await db.listProjects(LOCAL_PARTITION)).toEqual([])
})

test("on signing in, a starter file the person changed moves with the rest", async () => {
  const db = new MemoryProjectDatabase()
  const account = device(new FakeProjectServer(), undefined, db)
  const starter = async () => welcome
  await ensureLocalProject(db, async () => {}, starter)
  await put(local(db), "welcome.mdx", "# Mine now\n")
  const id = await moveLocalProject(db, account.partition, undefined, starter)
  expect(id).not.toBeNull()
  expect(await account.paths(id!)).toEqual(["flow.d2", "welcome.mdx"])
  expect((await account.files(id!).read("welcome.mdx")).content).toBe("# Mine now\n")
})

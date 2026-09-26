import { describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"
import { IndexedProjectDatabase, MemoryProjectDatabase, type ProjectDatabase } from "./database"
import type { LocalFile, LocalProject } from "./model"
import { device, FakeProjectServer, put, shared } from "./testing"

const databases: Array<[string, () => ProjectDatabase]> = [
  ["memory", () => new MemoryProjectDatabase()],
  ["IndexedDB", () => new IndexedProjectDatabase(new IDBFactory())],
]

const project = (partition: string, id = crypto.randomUUID()): LocalProject => ({
  partition,
  id,
  title: "Notes",
  pendingTitle: null,
  role: "owner",
  revision: 0,
  created: false,
  archivedAt: null,
  syncError: null,
  pending: null,
})

const file = (partition: string, projectId: string, path: string, baseId: string | null): LocalFile => ({
  partition,
  projectId,
  localId: crypto.randomUUID(),
  path,
  base: baseId ? { id: baseId, path, version: 1, content: "x" } : null,
  content: "x",
  batch: null,
  draft: null,
  conflict: null,
})

for (const [name, open] of databases) {
  describe(name, () => {
    test("a transaction that throws leaves nothing behind", async () => {
      const db = open()
      const p = project("one")
      await db.transaction("one", "readwrite", (tx) => tx.putProject(p))
      await expect(
        db.transaction("one", "readwrite", async (tx) => {
          await tx.putFile(file("one", p.id, "a.md", null))
          throw new Error("stop")
        }),
      ).rejects.toThrow("stop")
      expect(await db.transaction("one", "readonly", (tx) => tx.listFiles(p.id))).toEqual([])
    })

    test("files are found by server id, and accounts never see each other's records", async () => {
      const db = open()
      const p = project("one")
      const baseId = crypto.randomUUID()
      await db.transaction("one", "readwrite", async (tx) => {
        await tx.putProject(p)
        await tx.putFile(file("one", p.id, "local.md", null))
        await tx.putFile(file("one", p.id, "synced.md", baseId))
        await tx.putFolder({ partition: "one", projectId: p.id, path: "empty", base: false, local: true })
      })
      expect((await db.transaction("one", "readonly", (tx) => tx.findFileByBaseId(p.id, baseId)))?.path).toBe("synced.md")
      expect(await db.listProjects("two")).toEqual([])
      expect(await db.transaction("two", "readonly", (tx) => tx.listFiles(p.id))).toEqual([])
      await expect(db.transaction("two", "readwrite", (tx) => tx.putProject(p))).rejects.toThrow("between accounts")

      await db.transaction("one", "readwrite", (tx) => tx.deleteProject(p.id))
      expect(await db.transaction("one", "readonly", async (tx) => [...(await tx.listFiles(p.id)), ...(await tx.listFolders(p.id))])).toEqual([])
    })

    test("two devices sync a project through it", async () => {
      const server = new FakeProjectServer()
      const [a, b] = [device(server, undefined, open()), device(server, undefined, open())]
      const id = await shared(server, a, b, { "a.md": "a", "d/b.md": "b" })
      await put(b.files(id), "a.md", "edited on b")
      await b.sync.sync(id)
      await a.sync.sync(id)
      expect((await a.files(id).read("a.md")).content).toBe("edited on b")
      expect(await a.paths(id)).toEqual(["a.md", "d/b.md"])
    })
  })
}

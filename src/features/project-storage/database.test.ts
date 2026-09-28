import { describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"
import { deleteAccountProjects, IndexedProjectDatabase, MemoryProjectDatabase, type ProjectDatabase } from "./database"
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
        await tx.putFolder({ partition: "one", projectId: p.id, path: "empty", base: false, local: true, batch: null })
      })
      expect((await db.transaction("one", "readonly", (tx) => tx.findFileByBaseId(p.id, baseId)))?.path).toBe("synced.md")
      expect(await db.listProjects("two")).toEqual([])
      expect(await db.transaction("two", "readonly", (tx) => tx.listFiles(p.id))).toEqual([])
      await expect(db.transaction("two", "readwrite", (tx) => tx.putProject(p))).rejects.toThrow("between accounts")

      await db.transaction("one", "readwrite", (tx) => tx.deleteProject(p.id))
      expect(await db.transaction("one", "readonly", async (tx) => [...(await tx.listFiles(p.id)), ...(await tx.listFolders(p.id))])).toEqual([])
    })

    test("deleting an account's projects takes their files, folders and drafts, and leaves other accounts'", async () => {
      const db = open()
      const [mine, alsoMine, theirs] = [project("one"), project("one"), project("two")]
      await db.transaction("one", "readwrite", async (tx) => {
        await tx.putProject(mine)
        await tx.putProject(alsoMine)
        await tx.putFile({ ...file("one", mine.id, "a.md", null), draft: { content: "unsaved", token: null } })
        await tx.putFolder({ partition: "one", projectId: alsoMine.id, path: "empty", base: false, local: true, batch: null })
      })
      await db.transaction("two", "readwrite", async (tx) => {
        await tx.putProject(theirs)
        await tx.putFile(file("two", theirs.id, "b.md", null))
      })
      await deleteAccountProjects(db, "one")
      expect(await db.listProjects("one")).toEqual([])
      expect(await db.transaction("one", "readonly", async (tx) => [...(await tx.listFiles(mine.id)), ...(await tx.listFolders(alsoMine.id))])).toEqual([])
      expect((await db.listProjects("two")).map((p) => p.id)).toEqual([theirs.id])
      expect((await db.transaction("two", "readonly", (tx) => tx.listFiles(theirs.id))).map((f) => f.path)).toEqual(["b.md"])
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

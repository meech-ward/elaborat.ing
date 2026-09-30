import { expect, test } from "bun:test"
import { companionPaths, fileState, isValidProjectPath, LocalFile, LocalFolder, LocalProject, partitionKey } from "./model"

test("paths follow the database rule", () => {
  for (const path of ["a.md", "notes/a.md", "Ünïcode/名前.md", "a b/c-d_e.md", "x".repeat(2 ** 10)]) expect(isValidProjectPath(path)).toBe(true)
  for (const path of ["", "/a.md", "a/", "a//b", ".hidden", "a/.b", "a\\b", "a:b", "a\u0000b", "a\u0085b", "x".repeat(2 ** 10 + 1), "é.md"]) {
    expect(isValidProjectPath(path)).toBe(false)
  }
})

test("D2 sources pair with their scene and sidecar, both ways", () => {
  expect(companionPaths("d/flow.d2")).toEqual(["d/flow.excalidraw", "d/flow.d2.json"])
  expect(companionPaths("d/flow.excalidraw")).toEqual(["d/flow.d2", "d/flow.d2.json"])
  expect(companionPaths("d/flow.d2.json")).toEqual(["d/flow.d2", "d/flow.excalidraw"])
  expect(companionPaths("notes/a.md")).toEqual([])
})

test("a file's state is how its saved copy differs from the server's", () => {
  const base = { id: crypto.randomUUID(), path: "a.md", version: 3, content: "x" }
  const file = (patch: Partial<LocalFile>): LocalFile => ({
    partition: "p",
    projectId: crypto.randomUUID(),
    localId: crypto.randomUUID(),
    path: "a.md",
    base,
    content: "x",
    batch: null,
    draft: null,
    conflict: null,
    ...patch,
  })
  expect(fileState(file({}))).toBe("clean")
  expect(fileState(file({ content: "y" }))).toBe("changed")
  expect(fileState(file({ path: "b.md" }))).toBe("moved")
  expect(fileState(file({ content: null }))).toBe("deleted")
  expect(fileState(file({ base: null }))).toBe("created")
  expect(fileState(file({ base: null, content: null }))).toBe("clean")
  expect(fileState(file({ draft: { content: "unsaved", token: null } }))).toBe("clean")
})

test("the partition key names the backend origin and the account", () => {
  const user = "5f0c6f9e-2d7b-4a57-9d63-1d3f6f0b9c11"
  expect(partitionKey("https://abc.supabase.co/rest/v1", user)).toBe(JSON.stringify(["https://abc.supabase.co", user]))
  expect(() => partitionKey("https://abc.supabase.co", "not-a-uuid")).toThrow()
})

test("stored rows are checked as they are read: a folder from before batches gets none, and bad rows are refused", () => {
  const projectId = crypto.randomUUID()
  const folder = { partition: "p", projectId, path: "notes", base: true, local: true }
  expect(LocalFolder.parse(folder)).toEqual({ ...folder, batch: null })
  expect(LocalFolder.safeParse({ ...folder, path: "a//b" }).success).toBe(false)
  expect(LocalFolder.safeParse({ ...folder, batch: null, extra: 1 }).success).toBe(false)

  const file = { partition: "p", projectId, localId: crypto.randomUUID(), path: "a.md", base: null, content: "x", batch: null, draft: null, conflict: null }
  expect(LocalFile.parse(file)).toEqual(file)
  expect(LocalFile.safeParse({ ...file, localId: "not-a-uuid" }).success).toBe(false)
  expect(LocalFile.safeParse({ ...file, base: { id: crypto.randomUUID(), path: "a.md", version: 0, content: "x" } }).success).toBe(false)

  const project: LocalProject = {
    partition: "p",
    id: projectId,
    title: "Notes",
    pendingTitle: null,
    role: "owner",
    revision: 0,
    created: true,
    archivedAt: null,
    syncError: null,
    pending: {
      mutationId: crypto.randomUUID(),
      changes: [{ op: "put", path: "a.md", content: "x" }],
      files: [{ localId: file.localId, sentPath: "a.md", sentContent: "x" }],
      folders: [],
    },
  }
  expect(LocalProject.parse(project)).toEqual(project)
  expect(LocalProject.safeParse({ ...project, revision: -1 }).success).toBe(false)
  expect(LocalProject.safeParse({ ...project, role: "admin" }).success).toBe(false)
  expect(LocalProject.safeParse({ ...project, pending: { ...project.pending, changes: [] } }).success).toBe(false)
  expect(LocalProject.safeParse({ ...project, pending: { ...project.pending, changes: [{ op: "delete", path: "a.md" }] } }).success).toBe(false)
})

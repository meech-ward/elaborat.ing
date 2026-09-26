import { expect } from "bun:test"
import { MemoryProjectDatabase, type ProjectDatabase } from "./database"
import { FakeProjectServer } from "./fakeServer"
import { ProjectFileStore } from "./fileStore"
import { partitionKey } from "./model"
import { ProjectSync } from "./sync"

/** Test helpers: a device is one browser profile signed in as one person. */

export const OWNER = "0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01"
export const OTHER = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"

export type Device = ReturnType<typeof device>

export function device(server: FakeProjectServer, user = OWNER, db: ProjectDatabase = new MemoryProjectDatabase()) {
  const partition = partitionKey("https://example.supabase.co", user)
  const sync = new ProjectSync(db, server.remote(user), partition)
  return {
    db,
    partition,
    sync,
    files: (projectId: string) => new ProjectFileStore(db, partition, projectId),
    project: (projectId: string) => db.transaction(partition, "readonly", (tx) => tx.getProject(projectId)),
    record: (projectId: string, path: string) => db.transaction(partition, "readonly", (tx) => tx.getFile(projectId, path)),
    paths: async (projectId: string) => (await new ProjectFileStore(db, partition, projectId).listEntries()).files.map((file) => file.path),
  }
}

/** Save a file on a device, based on whatever is saved there now. */
export async function put(store: ProjectFileStore, path: string, content: string) {
  const existing = await store.read(path).catch(() => null)
  return store.write(path, content, existing && existing.savedContent !== null ? existing.revision : null)
}

/** A synced project on `a`, downloaded onto `b`. */
export async function shared(server: FakeProjectServer, a: Device, b: Device, files: Record<string, string>) {
  const project = await a.sync.createProject("Shared")
  const store = a.files(project.id)
  for (const [path, content] of Object.entries(files)) await put(store, path, content)
  expect((await a.sync.sync(project.id)).status).toBe("synced")
  const entry = (await b.sync.refresh()).find((candidate) => candidate.id === project.id)!
  await b.sync.download(entry)
  return project.id
}

export { FakeProjectServer }

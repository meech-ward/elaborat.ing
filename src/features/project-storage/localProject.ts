import type { ProjectDatabase } from "./database"
import type { LocalProject } from "./model"
import { defaultLock, type Lock } from "./sync"

/**
 * The one project someone without an account keeps in this browser. It lives
 * in its own partition of the same on-device store as every project, and
 * never syncs. Signing in moves it into the account's partition as a new
 * project, which then syncs like any project made offline.
 */
export const LOCAL_PARTITION = "local"
export const LOCAL_PROJECT_ID = "6c0ca1a0-0000-4000-8000-000000000001"
export const LOCAL_PROJECT_TITLE = "Local project"

type Persist = () => Promise<unknown>
const askToPersist: Persist = async () => globalThis.navigator?.storage?.persist?.()

/**
 * Make sure the local project is on this device. The first time, ask the
 * browser to keep this site's storage (the only copy of the work) through
 * storage pressure.
 */
export async function ensureLocalProject(db: ProjectDatabase, persist: Persist = askToPersist): Promise<void> {
  const created = await db.transaction(LOCAL_PARTITION, "readwrite", async (tx) => {
    if (await tx.getProject(LOCAL_PROJECT_ID)) return false
    await tx.putProject({
      partition: LOCAL_PARTITION,
      id: LOCAL_PROJECT_ID,
      title: LOCAL_PROJECT_TITLE,
      pendingTitle: null,
      role: "owner",
      revision: 0,
      created: false,
      archivedAt: null,
      syncError: null,
      pending: null,
    })
    return true
  })
  // Not awaited: Firefox asks the person, and the answer can take any time.
  if (created) void Promise.resolve().then(persist).catch(() => undefined)
}

/**
 * Move the local project into an account's partition as a new project named
 * "Local project", not yet on the server, so the next sync creates it and
 * saves its files. Returns its id, or null when there was nothing to move (no
 * local project, or one without files, which is just removed). Serialized
 * across tabs, so it moves once.
 */
export function moveLocalProject(db: ProjectDatabase, partition: string, lock: Lock = defaultLock()): Promise<string | null> {
  return lock("elaborating-local-project", async () => {
    const found = await db.transaction(LOCAL_PARTITION, "readonly", async (tx) => ({
      project: await tx.getProject(LOCAL_PROJECT_ID),
      files: await tx.listFiles(LOCAL_PROJECT_ID),
      folders: await tx.listFolders(LOCAL_PROJECT_ID),
    }))
    if (!found.project) return null
    const files = found.files.filter((file) => file.content !== null || file.draft !== null)
    let id: string | null = null
    if (files.length > 0) {
      const moved: LocalProject = {
        ...found.project,
        partition,
        id: crypto.randomUUID(),
        title: LOCAL_PROJECT_TITLE,
        pendingTitle: null,
        role: "owner",
        revision: 0,
        created: false,
        archivedAt: null,
        syncError: null,
        pending: null,
      }
      id = moved.id
      // Written to the account first, so a failure in between leaves a second copy rather than none.
      await db.transaction(partition, "readwrite", async (tx) => {
        await tx.putProject(moved)
        for (const file of files) await tx.putFile({ ...file, partition, projectId: moved.id, base: null, conflict: null })
        for (const folder of found.folders) {
          if (folder.local) await tx.putFolder({ ...folder, partition, projectId: moved.id, base: false })
        }
      })
    }
    await db.transaction(LOCAL_PARTITION, "readwrite", (tx) => tx.deleteProject(LOCAL_PROJECT_ID))
    return id
  })
}

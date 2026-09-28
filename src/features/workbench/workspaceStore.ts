import { FileStoreError, type ConflictCopies, type FileRef, type LocalChange, type ProjectFileStore, type StoredFile } from "@/features/project-storage/fileStore"

/**
 * The storage the workbench edits through: one project's files on this
 * device. Saves are local and checked against the revision the editor last
 * read (a content token); sync sends them to the server separately. A save
 * whose saved copy changed in the meantime throws `LocalConflictError` from
 * the file store.
 */
export interface WorkspaceStore {
  /** Scopes the workbench's browser preferences (tabs, views, folders) to this project. */
  readonly persistenceKey: string
  /** `directories` holds every folder, explicit or implied by file paths; `folders` only the explicit ones. */
  listEntries(): Promise<{ files: WorkspaceFileRef[]; directories: string[]; folders: string[] }>
  read(path: string): Promise<WorkspaceFile>
  /** Both versions of a file whose sync conflicts (this device's and the server's), or null when it has none. */
  readConflict(path: string): Promise<ConflictCopies | null>
  write(path: string, input: { content: string; expectedRevision: string | null }): Promise<{ path: string; revision: string; size: number }>
  createDirectory(path: string): Promise<{ path: string }>
  /** Apply moves and writes on this device as one save that syncs together. */
  save(changes: LocalChange[]): Promise<Array<{ path: string; revision: string; size: number }>>
  persistDrafts(entries: Array<{ path: string; content: string; baseRevision: string | null }>): Promise<void>
  flushLocalDrafts(): Promise<void>
  discardLocalDraft(path: string): Promise<void>
  /** Rename a new file that was never saved: only the name it will be saved under changes. */
  renameDraft(from: string, to: string): Promise<void>
  /** Called after any change on this device, including changes sync brings in. */
  subscribe(listener: () => void): () => void
}

/** A listed file. `revision` is null for a file that exists only as an unsaved draft. */
export type WorkspaceFileRef = Omit<FileRef, "revision"> & { revision: string | null }
export type WorkspaceFile = Omit<StoredFile, "revision"> & { revision: string | null }

const revisionOf = (token: string): string | null => (token === "" ? null : token)

/** The file is not in the project (a remembered tab whose file is gone, for example). */
export class MissingFileError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not in this project.`)
    this.name = "MissingFileError"
  }
}

/** The key that scopes a project's workbench preferences in this browser (`WorkspaceStore.persistenceKey`). */
export const workspacePersistenceKey = (partition: string, projectId: string): string => JSON.stringify([partition, projectId])

/**
 * The workbench's storage for one project. `afterSave` runs after every local
 * save (to start a sync); `subscribeSync` reports changes sync makes.
 */
export function projectWorkspace(
  store: ProjectFileStore,
  { afterSave, subscribeSync }: { afterSave: () => void; subscribeSync: (listener: () => void) => () => void },
): WorkspaceStore {
  return {
    persistenceKey: workspacePersistenceKey(store.partition, store.projectId),
    async listEntries() {
      const { files, directories, folders } = await store.listEntries()
      return { files: files.map((file) => ({ ...file, revision: revisionOf(file.revision) })), directories, folders }
    },
    async read(path) {
      let file: StoredFile
      try {
        file = await store.read(path)
      } catch (error) {
        if (error instanceof FileStoreError && error.message.endsWith("is not in this project.")) throw new MissingFileError(path)
        throw error
      }
      return { ...file, revision: revisionOf(file.revision) }
    },
    readConflict: (path) => store.conflictCopies(path),
    async write(path, { content, expectedRevision }) {
      const saved = await store.write(path, content, expectedRevision)
      afterSave()
      return saved
    },
    async save(changes) {
      const saved = await store.save(changes)
      afterSave()
      return saved
    },
    async createDirectory(path) {
      await store.createDirectory(path)
      afterSave()
      return { path }
    },
    persistDrafts: (entries) => store.persistDrafts(entries),
    flushLocalDrafts: () => store.flushDrafts(),
    discardLocalDraft: (path) => store.discardDraft(path),
    renameDraft: (from, to) => store.renameDraft(from, to),
    subscribe(listener) {
      const local = store.subscribe(listener)
      const synced = subscribeSync(listener)
      return () => {
        local()
        synced()
      }
    },
  }
}

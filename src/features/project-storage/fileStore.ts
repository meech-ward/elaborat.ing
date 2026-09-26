import type { ProjectDatabase, StorageTransaction } from "./database"
import {
  byteLength,
  canEdit,
  contentToken,
  isValidProjectPath,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  type LocalFile,
  type LocalProject,
} from "./model"

/**
 * One project's files as the workbench sees them. Everything here happens on
 * the device: saving writes the local copy and leaves syncing to the sync
 * layer. Revisions are the editor's content tokens (SHA-256 of the saved
 * copy); an empty string means there is no saved copy.
 */

export type FileRef = {
  path: string
  /** Token of the saved copy, or "" when the file has never been saved. */
  revision: string
  size: number
  /** Has unsaved edits kept on this device. */
  draft: boolean
  /** Saved on this device but not yet on the server. */
  unsynced: boolean
  /** A save of this file was refused because the server copy changed; see the sync layer to resolve. */
  conflict: boolean
}

export type StoredFile = FileRef & {
  /** The draft if there is one, otherwise the saved copy. */
  content: string
  /** The saved copy, or null when there is none. Present so a draft can be compared or discarded. */
  savedContent: string | null
}

/** One change in a local save. All changes in one save share a batch and sync together. */
export type LocalChange =
  | { kind: "write"; path: string; content: string; expectedRevision: string | null }
  | { kind: "move"; from: string; to: string; expectedRevision: string; content?: string }
  | { kind: "delete"; path: string; expectedRevision: string }

export class LocalConflictError extends Error {
  constructor(readonly path: string, readonly currentRevision: string, readonly currentContent: string | null) {
    super(`${path} changed on this device since it was opened.`)
    this.name = "LocalConflictError"
  }
}

export class FileStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FileStoreError"
  }
}

function checkPath(path: string): void {
  if (!isValidProjectPath(path)) throw new FileStoreError(`"${path}" is not a valid file name or path.`)
}

function checkSize(path: string, content: string): void {
  if (byteLength(content) > MAX_FILE_BYTES) throw new FileStoreError(`${path} is larger than 2 MiB.`)
}

const ancestors = (path: string): string[] => {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

export class ProjectFileStore {
  private listeners = new Set<() => void>()
  private draftQueue: Promise<void> = Promise.resolve()
  private draftFailure: unknown = null

  constructor(
    private readonly db: ProjectDatabase,
    readonly partition: string,
    readonly projectId: string,
  ) {}

  /** Called after every committed local change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  private async project(tx: StorageTransaction): Promise<LocalProject> {
    const project = await tx.getProject(this.projectId)
    if (!project) throw new FileStoreError("This project is not on this device.")
    return project
  }

  private async editableProject(tx: StorageTransaction): Promise<LocalProject> {
    const project = await this.project(tx)
    if (!canEdit(project.role)) throw new FileStoreError("You can view this project but not change it.")
    if (project.archivedAt) throw new FileStoreError("This project is archived. Unarchive it to make changes.")
    return project
  }

  private async ref(file: LocalFile): Promise<StoredFile | null> {
    const saved = file.content
    const content = file.draft?.content ?? saved
    if (content === null) return null
    return {
      path: file.path,
      content,
      savedContent: saved,
      revision: saved === null ? "" : await contentToken(saved),
      size: byteLength(content),
      draft: file.draft !== null,
      unsynced: file.base === null ? saved !== null : saved !== file.base.content || file.path !== file.base.path,
      conflict: file.conflict !== null,
    }
  }

  async listEntries(): Promise<{ files: FileRef[]; directories: string[] }> {
    const { files, folders } = await this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.project(tx)
      return { files: await tx.listFiles(this.projectId), folders: await tx.listFolders(this.projectId) }
    })
    const refs: FileRef[] = []
    for (const file of files) {
      const stored = await this.ref(file)
      if (!stored) continue
      const { content: _content, savedContent: _saved, ...ref } = stored
      void _content
      void _saved
      refs.push(ref)
    }
    const directories = new Set<string>()
    for (const folder of folders) if (folder.local) directories.add(folder.path)
    for (const ref of refs) for (const ancestor of ancestors(ref.path)) directories.add(ancestor)
    return { files: refs, directories: [...directories].sort() }
  }

  async read(path: string): Promise<StoredFile> {
    checkPath(path)
    const file = await this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.project(tx)
      return tx.getFile(this.projectId, path)
    })
    const stored = file ? await this.ref(file) : null
    if (!stored) throw new FileStoreError(`${path} is not in this project.`)
    return stored
  }

  /** Save one file on this device. */
  async write(path: string, content: string, expectedRevision: string | null) {
    const [result] = await this.save([{ kind: "write", path, content, expectedRevision }])
    return result
  }

  /** Save several files on this device as one batch that syncs atomically. */
  async writeBatch(entries: Array<{ path: string; content: string; expectedRevision: string | null }>) {
    return this.save(entries.map((entry) => ({ kind: "write" as const, ...entry })))
  }

  async move(from: string, to: string, expectedRevision: string, content?: string) {
    const [result] = await this.save([{ kind: "move", from, to, expectedRevision, content }])
    return result
  }

  async delete(path: string, expectedRevision: string) {
    await this.save([{ kind: "delete", path, expectedRevision }])
  }

  /**
   * Apply a list of changes on this device atomically, as one batch. Each
   * change names the revision it was based on; if the saved copy has changed
   * since, nothing is saved and a LocalConflictError names the file.
   */
  async save(changes: LocalChange[]): Promise<Array<{ path: string; revision: string; size: number }>> {
    if (changes.length === 0) return []
    if (changes.length > MAX_ENTRIES) throw new FileStoreError("A save can change at most 4096 files.")
    const touched = new Set<string>()
    for (const change of changes) {
      const paths = change.kind === "move" ? [change.from, change.to] : [change.path]
      for (const path of paths) {
        checkPath(path)
        if (touched.has(path)) throw new FileStoreError(`A save can change each path only once: ${path}`)
        touched.add(path)
      }
      if (change.kind === "write") checkSize(change.path, change.content)
      if (change.kind === "move" && change.content !== undefined) checkSize(change.to, change.content)
    }

    // Hash outside the write transaction, then make sure nothing changed in between.
    const sourcePaths = changes.map((change) => (change.kind === "move" ? change.from : change.path))
    const before = await this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.editableProject(tx)
      return Promise.all(sourcePaths.map((path) => tx.getFile(this.projectId, path)))
    })
    for (const [index, change] of changes.entries()) {
      const file = before[index]
      const saved = file?.content ?? null
      const current = saved === null ? "" : await contentToken(saved)
      const expected = change.expectedRevision ?? ""
      if (current !== expected) throw new LocalConflictError(sourcePaths[index], current, saved)
    }

    const batch = changes.length > 1 ? crypto.randomUUID() : null
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      const project = await this.editableProject(tx)
      const inFlight = new Set(project.pending?.files.map((entry) => entry.localId) ?? [])
      for (const [index, change] of changes.entries()) {
        const source = await tx.getFile(this.projectId, sourcePaths[index])
        if ((source?.content ?? null) !== (before[index]?.content ?? null)) {
          throw new LocalConflictError(sourcePaths[index], "", source?.content ?? null)
        }
        if (change.kind === "write") {
          await this.checkFree(tx, change.path, source)
          const file: LocalFile = source ?? {
            partition: this.partition,
            projectId: this.projectId,
            localId: crypto.randomUUID(),
            path: change.path,
            base: null,
            content: null,
            batch: null,
            draft: null,
            conflict: null,
          }
          await tx.putFile({
            ...file,
            content: change.content,
            batch: batch ?? file.batch,
            draft: file.draft?.content === change.content ? null : file.draft,
          })
        } else if (change.kind === "move") {
          if (!source || source.content === null) throw new FileStoreError(`${change.from} is not in this project.`)
          if (source.draft) throw new FileStoreError(`Save or discard the unsaved edits in ${change.from} before moving it.`)
          const occupant = await tx.getFile(this.projectId, change.to)
          if (occupant?.draft) throw new FileStoreError(`${change.to} has unsaved edits. Save or discard them first.`)
          if (occupant && (occupant.content !== null || occupant.base !== null)) {
            throw new FileStoreError(
              occupant.content !== null
                ? `${change.to} already exists.`
                : `${change.to} was just deleted and is still syncing. Try again once it has synced.`,
            )
          }
          await this.checkFree(tx, change.to, null)
          await tx.deleteFile(this.projectId, source.path)
          await tx.putFile({
            ...source,
            path: change.to,
            content: change.content ?? source.content,
            batch: batch ?? source.batch,
            draft: null,
            // Moving is how a file whose path was taken on the server gets a free one.
            conflict: source.conflict?.pathTaken ? null : source.conflict,
          })
        } else {
          if (!source || source.content === null) throw new FileStoreError(`${change.path} is not in this project.`)
          if (source.base === null && !inFlight.has(source.localId)) {
            // Never synced and not being sent: nothing to tell the server.
            await tx.deleteFile(this.projectId, source.path)
          } else {
            await tx.putFile({ ...source, content: null, batch: batch ?? source.batch, draft: null })
          }
        }
      }
    })
    this.emit()

    const results = []
    for (const change of changes) {
      if (change.kind === "delete") continue
      const path = change.kind === "move" ? change.to : change.path
      const content = change.kind === "move" ? (change.content ?? before[changes.indexOf(change)]?.content ?? "") : change.content
      results.push({ path, revision: await contentToken(content), size: byteLength(content) })
    }
    return results
  }

  /** A file cannot sit where a folder is, and no ancestor of a path can be a file. */
  private async checkFree(tx: StorageTransaction, path: string, self: LocalFile | null): Promise<void> {
    const folders = await tx.listFolders(this.projectId)
    const files = await tx.listFiles(this.projectId)
    const live = files.filter((file) => file.content !== null && file.localId !== self?.localId)
    if (folders.some((folder) => folder.local && folder.path === path)) throw new FileStoreError(`${path} is a folder.`)
    for (const ancestor of ancestors(path)) {
      if (live.some((file) => file.path === ancestor)) throw new FileStoreError(`${ancestor} is a file, so it cannot contain ${path}.`)
    }
    if (live.some((file) => file.path.startsWith(`${path}/`))) throw new FileStoreError(`${path} already contains other files.`)
  }

  async createDirectory(path: string): Promise<void> {
    checkPath(path)
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.editableProject(tx)
      const existing = await tx.getFile(this.projectId, path)
      if (existing && existing.content !== null) throw new FileStoreError(`${path} is a file.`)
      const files = await tx.listFiles(this.projectId)
      for (const ancestor of ancestors(path)) {
        if (files.some((file) => file.content !== null && file.path === ancestor)) {
          throw new FileStoreError(`${ancestor} is a file, so it cannot contain ${path}.`)
        }
      }
      const folder = (await tx.listFolders(this.projectId)).find((candidate) => candidate.path === path)
      if (folder?.local) throw new FileStoreError(`${path} already exists.`)
      await tx.putFolder({ partition: this.partition, projectId: this.projectId, path, base: folder?.base ?? false, local: true })
    })
    this.emit()
  }

  /** Remove an explicit folder entry. Files inside keep their paths. */
  async removeDirectory(path: string): Promise<void> {
    checkPath(path)
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.editableProject(tx)
      const folder = (await tx.listFolders(this.projectId)).find((candidate) => candidate.path === path)
      if (!folder?.local) return
      if (folder.base) await tx.putFolder({ ...folder, local: false })
      else await tx.deleteFolder(this.projectId, path)
    })
    this.emit()
  }

  /**
   * Keep unsaved edits on this device. Queued, so drafts are written in the
   * order they were made; a draft equal to the saved copy is removed.
   */
  persistDrafts(entries: Array<{ path: string; content: string; baseRevision: string | null }>): Promise<void> {
    const pending = this.draftQueue.then(() => this.writeDrafts(entries))
    this.draftQueue = pending.then(
      () => {
        this.draftFailure = null
      },
      (error: unknown) => {
        this.draftFailure = error
      },
    )
    return pending
  }

  /** Wait for queued drafts; throws if the last one could not be kept. */
  async flushDrafts(): Promise<void> {
    await this.draftQueue
    if (this.draftFailure) throw this.draftFailure
  }

  async discardDraft(path: string): Promise<void> {
    await this.draftQueue.catch(() => {})
    checkPath(path)
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.project(tx)
      const file = await tx.getFile(this.projectId, path)
      if (!file?.draft) return
      if (file.content === null && file.base === null) await tx.deleteFile(this.projectId, path)
      else await tx.putFile({ ...file, draft: null })
    })
    this.emit()
  }

  private async writeDrafts(entries: Array<{ path: string; content: string; baseRevision: string | null }>) {
    for (const entry of entries) {
      checkPath(entry.path)
      checkSize(entry.path, entry.content)
    }
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.project(tx)
      for (const entry of entries) {
        const file = await tx.getFile(this.projectId, entry.path)
        if (file && file.content === entry.content) {
          if (file.draft) await tx.putFile({ ...file, draft: null })
          continue
        }
        if (file) {
          await tx.putFile({ ...file, draft: { content: entry.content, token: entry.baseRevision } })
        } else {
          await tx.putFile({
            partition: this.partition,
            projectId: this.projectId,
            localId: crypto.randomUUID(),
            path: entry.path,
            base: null,
            content: null,
            batch: null,
            draft: { content: entry.content, token: entry.baseRevision },
            conflict: null,
          })
        }
      }
    })
    this.emit()
  }
}

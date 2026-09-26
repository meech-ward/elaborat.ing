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
  /** Explicit folders, made or removed in the same save as files (a folder move). */
  | { kind: "mkdir"; path: string }
  | { kind: "rmdir"; path: string }

type FileChange = Extract<LocalChange, { kind: "write" | "move" | "delete" }>
const isFileChange = (change: LocalChange): change is FileChange => change.kind !== "mkdir" && change.kind !== "rmdir"

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

/**
 * A file cannot sit where a folder is, and no ancestor of a path can be a
 * file. `folders` holds the local folders' paths; `live` maps each saved
 * file's path to its local id.
 */
function checkFree(folders: ReadonlySet<string>, live: ReadonlyMap<string, string>, path: string, self: LocalFile | null): void {
  if (folders.has(path)) throw new FileStoreError(`${path} is a folder.`)
  for (const ancestor of ancestors(path)) {
    const owner = live.get(ancestor)
    if (owner !== undefined && owner !== self?.localId) throw new FileStoreError(`${ancestor} is a file, so it cannot contain ${path}.`)
  }
  for (const [other, owner] of live) {
    if (owner !== self?.localId && other.startsWith(`${path}/`)) throw new FileStoreError(`${path} already contains other files.`)
  }
}

export class ProjectFileStore {
  private listeners = new Set<() => void>()
  private draftQueue: Promise<void> = Promise.resolve()
  /** Drafts waiting for the next write, by path (the latest text wins). */
  private queuedDrafts = new Map<string, { path: string; content: string; baseRevision: string | null }>()
  /** The write that will take `queuedDrafts`, until it starts. */
  private nextDraftWrite: Promise<void> | null = null
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

  /**
   * The files, and every folder: `directories` holds the explicit folders and
   * those implied by file paths; `folders` holds only the explicit ones.
   */
  async listEntries(): Promise<{ files: FileRef[]; directories: string[]; folders: string[] }> {
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
    const explicit = folders.filter((folder) => folder.local).map((folder) => folder.path)
    const directories = new Set(explicit)
    for (const ref of refs) for (const ancestor of ancestors(ref.path)) directories.add(ancestor)
    return { files: refs, directories: [...directories].sort(), folders: explicit.sort() }
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
    if (changes.length > MAX_ENTRIES) throw new FileStoreError("A save can make at most 4096 changes.")
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
    const fileChanges = changes.filter(isFileChange)
    const sourcePaths = fileChanges.map((change) => (change.kind === "move" ? change.from : change.path))
    const before = await this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.editableProject(tx)
      return Promise.all(sourcePaths.map((path) => tx.getFile(this.projectId, path)))
    })
    for (const [index, change] of fileChanges.entries()) {
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
      // Where the project's folders and files are, read once and kept current
      // as the changes apply, so a large save does not reread them per file.
      const folderRecords = new Map((await tx.listFolders(this.projectId)).map((folder) => [folder.path, folder]))
      const folders = new Set([...folderRecords.values()].filter((folder) => folder.local).map((folder) => folder.path))
      const live = new Map((await tx.listFiles(this.projectId)).filter((file) => file.content !== null).map((file) => [file.path, file.localId]))
      let fileIndex = 0
      for (const change of changes) {
        if (change.kind === "mkdir") {
          if (live.has(change.path)) throw new FileStoreError(`${change.path} is a file.`)
          const blocking = ancestors(change.path).find((ancestor) => live.has(ancestor))
          if (blocking) throw new FileStoreError(`${blocking} is a file, so it cannot contain ${change.path}.`)
          if (folders.has(change.path)) throw new FileStoreError(`${change.path} already exists.`)
          const known = folderRecords.get(change.path)
          await tx.putFolder({ partition: this.partition, projectId: this.projectId, path: change.path, base: known?.base ?? false, local: true, batch })
          folders.add(change.path)
          continue
        }
        if (change.kind === "rmdir") {
          const folder = folderRecords.get(change.path)
          if (!folder || !folders.has(change.path)) throw new FileStoreError(`There is no folder ${change.path}.`)
          if (folder.base) await tx.putFolder({ ...folder, local: false, batch })
          else await tx.deleteFolder(this.projectId, change.path)
          folders.delete(change.path)
          continue
        }
        const index = fileIndex++
        const source = await tx.getFile(this.projectId, sourcePaths[index])
        if ((source?.content ?? null) !== (before[index]?.content ?? null)) {
          throw new LocalConflictError(sourcePaths[index], "", source?.content ?? null)
        }
        if (change.kind === "write") {
          checkFree(folders, live, change.path, source)
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
            // This save supersedes a draft made on the same saved copy (or one it matches).
            draft:
              file.draft && (file.draft.content === change.content || file.draft.token === change.expectedRevision) ? null : file.draft,
          })
          live.set(change.path, file.localId)
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
          checkFree(folders, live, change.to, null)
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
          live.delete(source.path)
          live.set(change.to, source.localId)
        } else {
          if (!source || source.content === null) throw new FileStoreError(`${change.path} is not in this project.`)
          if (source.draft) throw new FileStoreError(`Save or discard the unsaved edits in ${change.path} before deleting it.`)
          if (source.base === null && !inFlight.has(source.localId)) {
            // Never synced and not being sent: nothing to tell the server.
            await tx.deleteFile(this.projectId, source.path)
          } else {
            await tx.putFile({ ...source, content: null, batch: batch ?? source.batch, draft: null })
          }
          live.delete(source.path)
        }
      }
    })
    this.emit()

    const results = []
    for (const [index, change] of fileChanges.entries()) {
      if (change.kind === "delete") continue
      const path = change.kind === "move" ? change.to : change.path
      const content = change.kind === "move" ? (change.content ?? before[index]?.content ?? "") : change.content
      results.push({ path, revision: await contentToken(content), size: byteLength(content) })
    }
    return results
  }

  async createDirectory(path: string): Promise<void> {
    await this.createDirectories([path])
  }

  /** Create several folders on this device at once; if one cannot be created, none is. */
  async createDirectories(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    for (const path of paths) checkPath(path)
    if (new Set(paths).size !== paths.length) throw new FileStoreError("Each folder can be created only once.")
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.editableProject(tx)
      const files = new Set((await tx.listFiles(this.projectId)).filter((file) => file.content !== null).map((file) => file.path))
      const folders = new Map((await tx.listFolders(this.projectId)).map((folder) => [folder.path, folder]))
      for (const path of paths) {
        if (files.has(path)) throw new FileStoreError(`${path} is a file.`)
        for (const ancestor of ancestors(path)) {
          if (files.has(ancestor)) throw new FileStoreError(`${ancestor} is a file, so it cannot contain ${path}.`)
        }
        if (folders.get(path)?.local) throw new FileStoreError(`${path} already exists.`)
      }
      for (const path of paths) {
        await tx.putFolder({ partition: this.partition, projectId: this.projectId, path, base: folders.get(path)?.base ?? false, local: true, batch: null })
      }
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
      if (folder.base) await tx.putFolder({ ...folder, local: false, batch: null })
      else await tx.deleteFolder(this.projectId, path)
    })
    this.emit()
  }

  /**
   * Keep unsaved edits on this device; a draft equal to the saved copy is
   * removed. Writes are queued, one at a time. While one is waiting, newer
   * edits to the same file replace its queued text, so fast typing never
   * builds a backlog: at most one write waits behind the one in progress,
   * and it carries the latest text of every file. The promise settles once
   * this call's text (or a newer one) is written.
   */
  persistDrafts(entries: Array<{ path: string; content: string; baseRevision: string | null }>): Promise<void> {
    for (const entry of entries) this.queuedDrafts.set(entry.path, entry)
    if (!this.nextDraftWrite) {
      const write = this.draftQueue.then(() => {
        this.nextDraftWrite = null
        const batch = [...this.queuedDrafts.values()]
        this.queuedDrafts.clear()
        return this.writeDrafts(batch)
      })
      this.nextDraftWrite = write
      this.draftQueue = write.then(
        () => {
          this.draftFailure = null
        },
        (error: unknown) => {
          this.draftFailure = error
        },
      )
    }
    return this.nextDraftWrite
  }

  /** Wait for queued drafts; throws if the last one could not be kept. */
  async flushDrafts(): Promise<void> {
    await this.draftQueue
    if (this.draftFailure) throw this.draftFailure
  }

  /**
   * Give a new file that exists only as a draft (it was never saved) another
   * name: the draft moves to `to`, which must be free. Nothing reaches the
   * server until the file is saved.
   */
  async renameDraft(from: string, to: string): Promise<void> {
    await this.draftQueue.catch(() => {})
    checkPath(from)
    checkPath(to)
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.editableProject(tx)
      const file = await tx.getFile(this.projectId, from)
      if (!file?.draft || file.content !== null || file.base !== null) throw new FileStoreError(`${from} is not a new file that was never saved.`)
      if (await tx.getFile(this.projectId, to)) throw new FileStoreError(`${to} already exists.`)
      const folders = new Set((await tx.listFolders(this.projectId)).filter((folder) => folder.local).map((folder) => folder.path))
      const live = new Map((await tx.listFiles(this.projectId)).filter((other) => other.content !== null).map((other) => [other.path, other.localId]))
      checkFree(folders, live, to, file)
      await tx.deleteFile(this.projectId, from)
      await tx.putFile({ ...file, path: to })
    })
    this.emit()
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

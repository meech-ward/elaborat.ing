import type { ProjectDatabase, StorageTransaction } from "./database"
import {
  byteLength,
  canEdit,
  contentToken,
  isValidProjectPath,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_PROJECT_BYTES,
  savedToken,
  assetToken,
  ImageAssetSchema,
  type ImageAsset,
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
  kind?: "text" | "image"
  asset?: ImageAsset | null
  /** Token of the saved copy, or "" when the file has never been saved. */
  revision: string
  size: number
  /** Has unsaved edits kept on this device. */
  draft: boolean
  /** Saved on this device but not yet on the server. */
  unsynced: boolean
  /** A save of this file was refused because the server copy changed; see the sync layer to resolve. */
  conflict: boolean
  /**
   * The server's id for the file and the version of the copy this device
   * last got from it, or null when the server has no such file yet. The id
   * stays the same when the file is renamed or moved; comments hang off it.
   */
  server: { id: string; version: number } | null
}

export type StoredFile = FileRef & {
  /** The draft if there is one, otherwise the saved copy. */
  content: string
  /** The saved copy, or null when there is none. Present so a draft can be compared or discarded. */
  savedContent: string | null
}

/** A file's two versions while its sync conflict waits for a choice. */
export type ConflictCopies = {
  /** The copy saved on this device, or null when it was deleted here. */
  mine: string | null
  /** The server's copy, or null when the server no longer has the file. */
  theirs: string | null
  /** Immutable image versions. Bytes remain in the account's local asset cache. */
  mineAsset?: ImageAsset | null
  theirsAsset?: ImageAsset | null
}

/** One change in a local save. All changes in one save share a batch and sync together. */
export type LocalChange =
  | { kind: "write"; path: string; content: string; expectedRevision: string | null }
  | { kind: "asset"; path: string; asset: ImageAsset; expectedRevision: string | null }
  | { kind: "move"; from: string; to: string; expectedRevision: string; content?: string; asset?: ImageAsset }
  | { kind: "delete"; path: string; expectedRevision: string }
  /** Explicit folders, made or removed in the same save as files (a folder move). */
  | { kind: "mkdir"; path: string }
  | { kind: "rmdir"; path: string }

type FileChange = Extract<LocalChange, { kind: "write" | "asset" | "move" | "delete" }>
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
      ...(file.kind === "image" ? { kind: "image" as const, asset: file.draft?.asset ?? file.asset ?? null } : {}),
      revision: await savedToken(file),
      size: file.kind === "image" ? (file.draft?.asset ?? file.asset)?.byte_length ?? 0 : byteLength(content),
      draft: file.draft !== null,
      unsynced: file.base === null ? saved !== null : saved !== file.base.content || file.path !== file.base.path || (file.asset?.id ?? null) !== (file.base.asset?.id ?? null),
      conflict: file.conflict !== null,
      server: file.base === null ? null : { id: file.base.id, version: file.base.version },
    }
  }

  /**
   * The files, and every folder: `directories` holds the explicit folders and
   * those implied by file paths; `folders` holds only the explicit ones.
   */
  async listEntries(): Promise<{ files: FileRef[]; directories: string[]; folders: string[] }> {
    const { files, folders } = await this.db.transaction(this.partition, "readonly", async (tx) => {
      const [, files, folders] = await Promise.all([this.project(tx), tx.listFiles(this.projectId), tx.listFolders(this.projectId)])
      return { files, folders }
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

  /**
   * Every file and explicit folder on this device, read at once, for a
   * download: each file's saved copy (null for a new file that is only a
   * draft) and its unsaved edits (null without any).
   */
  async snapshot(): Promise<{ files: Array<{ path: string; saved: string | null; draft: string | null; kind?: "image"; asset?: ImageAsset | null; savedBytes?: Uint8Array; draftBytes?: Uint8Array }>; folders: string[] }> {
    const snapshot = await this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.project(tx)
      const files = (await tx.listFiles(this.projectId)).filter((file) => file.content !== null || file.draft !== null)
      const assets = new Map((await tx.listAssets(this.projectId)).map((asset) => [asset.id, asset]))
      const folders = (await tx.listFolders(this.projectId)).filter((folder) => folder.local).map((folder) => folder.path)
      return { files, assets, folders }
    })
    const files = await Promise.all(snapshot.files.map(async (file) => {
      const text = { path: file.path, saved: file.content, draft: file.draft?.content ?? null }
      if (file.kind !== "image") return text
      const original = file.asset && snapshot.assets.get(file.asset.id)?.bytes
      const draft = file.draft?.asset && snapshot.assets.get(file.draft.asset.id)?.bytes
      if (file.content !== null && !original) throw new FileStoreError(`${file.path} has not downloaded completely. Connect and sync before downloading this project.`)
      if (file.draft?.asset && !draft) throw new FileStoreError(`${file.path}'s image draft is missing from this device.`)
      return { ...text, kind: "image" as const, asset: file.draft?.asset ?? file.asset, ...(original ? { savedBytes: new Uint8Array(await original.arrayBuffer()) } : {}), ...(draft ? { draftBytes: new Uint8Array(await draft.arrayBuffer()) } : {}) }
    }))
    return { files, folders: snapshot.folders }
  }

  /** Persist a validated original and its note drafts together before inserting a reference. */
  async stageImage(path: string, bytes: Blob, metadata: ImageAsset, noteDrafts: Array<{ path: string; content: string; baseRevision: string | null }> = [], preview?: Blob): Promise<StoredFile> {
    checkPath(path)
    const asset = ImageAssetSchema.parse(metadata)
    if (asset.object_key !== `${this.projectId}/${asset.id}/original` || asset.preview_key !== `${this.projectId}/${asset.id}/preview`) throw new FileStoreError("This image belongs to another project.")
    if (bytes.size !== asset.byte_length) throw new FileStoreError("The image size does not match its metadata.")
    if (preview && (preview.size !== asset.preview_byte_length || preview.type !== asset.preview_type)) throw new FileStoreError("The image preview does not match its metadata.")
    const digest = await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer())
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    if (sha256 !== asset.sha256) throw new FileStoreError("The image bytes do not match their digest.")
    for (const draft of noteDrafts) { checkPath(draft.path); checkSize(draft.path, draft.content) }
    await this.flushDrafts()
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.editableProject(tx)
      const existing = await tx.getFile(this.projectId, path)
      if (existing && existing.kind !== "image") throw new FileStoreError(`${path} already exists as a text file.`)
      const files = await tx.listFiles(this.projectId)
      const total = files.filter((file) => file.path !== path && (file.content !== null || file.draft !== null)).reduce((sum, file) => sum + (file.kind === "image" ? (file.draft?.asset ?? file.asset)?.byte_length ?? 0 : byteLength(file.draft?.content ?? file.content ?? "")), asset.byte_length)
      if (total > MAX_PROJECT_BYTES) throw new FileStoreError("The files add up to more than 64 MiB.")
      const folders = new Set((await tx.listFolders(this.projectId)).filter((folder) => folder.local).map((folder) => folder.path))
      const live = new Map(files.filter((file) => file.content !== null || file.draft !== null).map((file) => [file.path, file.localId]))
      checkFree(folders, live, path, existing)
      const cached = await tx.getAsset(this.projectId, asset.id)
      if (cached && cached.asset.sha256 !== asset.sha256) throw new FileStoreError("An immutable image cannot be overwritten with different bytes.")
      await tx.putAsset({ partition: this.partition, projectId: this.projectId, id: asset.id, asset, bytes, ...(preview ? { preview } : cached?.preview ? { preview: cached.preview } : {}), uploaded: cached?.uploaded ?? false, ...(cached?.uploadAttempted ? { uploadAttempted: true } : {}) })
      const file: LocalFile = existing ?? { partition: this.partition, projectId: this.projectId, localId: crypto.randomUUID(), path, base: null, content: null, batch: null, draft: null, conflict: null }
      const token = file.content === null ? null : file.kind === "image" && file.asset ? assetToken(file.asset) : null
      await tx.putFile({ ...file, kind: "image", draft: { content: "", token, asset } })
      for (const draft of noteDrafts) {
        const note = await tx.getFile(this.projectId, draft.path)
        if (note?.kind === "image") throw new FileStoreError(`${draft.path} is an image, not a note.`)
        await tx.putFile({ ...(note ?? { partition: this.partition, projectId: this.projectId, localId: crypto.randomUUID(), path: draft.path, base: null, content: null, batch: null, conflict: null }), draft: { content: draft.content, token: draft.baseRevision } })
      }
    })
    this.emit()
    return this.read(path)
  }

  /** Save image drafts with the note changes that reference them as one sync batch. */
  async saveImages(paths: string[], writes: Array<{ path: string; content: string; expectedRevision: string | null }> = []) {
    await this.flushDrafts()
    const assets = await this.db.transaction(this.partition, "readonly", async (tx) => {
      const changes: LocalChange[] = []
      for (const path of new Set(paths)) {
        const file = await tx.getFile(this.projectId, path)
        if (!file || file.kind !== "image") throw new FileStoreError(`${path} is not an image in this project.`)
        if (file.draft?.asset) changes.push({ kind: "asset", path, asset: file.draft.asset, expectedRevision: file.draft.token })
      }
      return changes
    })
    return this.save([...assets, ...writes.map((write) => ({ kind: "write" as const, ...write }))])
  }

  /** Original bytes, or a bounded preview when one is available. Never a storage URL. */
  async readImage(path: string, preview = false): Promise<Blob> {
    checkPath(path)
    return this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.project(tx)
      const file = await tx.getFile(this.projectId, path)
      const asset = file?.draft?.asset ?? file?.asset
      if (file?.kind !== "image" || !asset || (file.content === null && file.draft === null)) throw new FileStoreError(`${path} is not an image in this project.`)
      const local = await tx.getAsset(this.projectId, asset.id)
      if (!local) throw new FileStoreError(`${path} has not downloaded completely. Connect and sync to download it.`)
      return preview && local.preview ? local.preview : local.bytes
    })
  }

  /** A cached immutable version, including either side of an image conflict. */
  async readImageAsset(assetId: string, preview = false): Promise<Blob> {
    return this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.project(tx)
      const local = await tx.getAsset(this.projectId, assetId)
      if (!local) throw new FileStoreError("This image version has not downloaded completely. Connect and sync to download it.")
      return preview && local.preview ? local.preview : local.bytes
    })
  }

  async draftImageAsset(path: string): Promise<ImageAsset | null> {
    checkPath(path)
    return this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.project(tx)
      return (await tx.getFile(this.projectId, path))?.draft?.asset ?? null
    })
  }

  /** Keep a verified committed historical asset without creating or changing a logical file. */
  async cacheImage(bytes: Blob, metadata: ImageAsset, preview?: Blob): Promise<void> {
    const asset = ImageAssetSchema.parse(metadata)
    if (asset.object_key !== `${this.projectId}/${asset.id}/original` || asset.preview_key !== `${this.projectId}/${asset.id}/preview`) throw new FileStoreError("This image belongs to another project.")
    if (bytes.size !== asset.byte_length) throw new FileStoreError("The image size does not match its metadata.")
    if (preview && (preview.size !== asset.preview_byte_length || preview.type !== asset.preview_type)) throw new FileStoreError("The image preview does not match its metadata.")
    const digest = await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer())
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    if (sha256 !== asset.sha256) throw new FileStoreError("The image bytes do not match their digest.")
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      await this.project(tx)
      const existing = await tx.getAsset(this.projectId, asset.id)
      if (existing && existing.asset.sha256 !== asset.sha256) throw new FileStoreError("An immutable image cannot be overwritten with different bytes.")
      await tx.putAsset({ partition: this.partition, projectId: this.projectId, id: asset.id, asset, bytes, ...(preview ? { preview } : existing?.preview ? { preview: existing.preview } : {}), uploaded: true })
    })
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

  /** Both versions of a file whose sync conflicts, or null when it has no conflict. */
  async conflictCopies(path: string): Promise<ConflictCopies | null> {
    checkPath(path)
    const file = await this.db.transaction(this.partition, "readonly", async (tx) => {
      await this.project(tx)
      return tx.getFile(this.projectId, path)
    })
    if (!file?.conflict) return null
    return {
      mine: file.content,
      theirs: file.conflict.current?.content ?? null,
      ...(file.kind === "image" || file.conflict.current?.kind === "image" ? {
        mineAsset: file.content !== null ? file.asset ?? null : null,
        theirsAsset: file.conflict.current?.asset ?? null,
      } : {}),
    }
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
      const current = file ? await savedToken(file) : ""
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
        if ((source?.content ?? null) !== (before[index]?.content ?? null) || (source?.asset?.id ?? null) !== (before[index]?.asset?.id ?? null)) {
          throw new LocalConflictError(sourcePaths[index], "", source?.content ?? null)
        }
        if (change.kind === "write" || change.kind === "asset") {
          if (change.kind === "write" && source?.kind === "image") throw new FileStoreError(`${change.path} is an image and cannot be overwritten with text.`)
          if (change.kind === "asset" && source && source.kind !== "image") throw new FileStoreError(`${change.path} is a text file and cannot be overwritten with an image.`)
          if (change.kind === "asset" && !(await tx.getAsset(this.projectId, change.asset.id))) throw new FileStoreError("The image bytes must be kept on this device before saving.")
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
            ...(change.kind === "asset" ? { kind: "image" as const, asset: change.asset, asset_id: change.asset.id } : {}),
            content: change.kind === "asset" ? "" : change.content,
            batch: batch ?? file.batch,
            // This save supersedes a draft made on the same saved copy (or one it matches).
            draft:
              file.draft && (change.kind === "asset" ? file.draft.asset?.id === change.asset.id : file.draft.content === change.content || file.draft.token === change.expectedRevision) ? null : file.draft,
          })
          live.set(change.path, file.localId)
        } else if (change.kind === "move") {
          if (!source || source.content === null) throw new FileStoreError(`${change.from} is not in this project.`)
          if (source.draft) throw new FileStoreError(`Save or discard the unsaved edits in ${change.from} before moving it.`)
          if (source.kind === "image" && change.content !== undefined) throw new FileStoreError("An image cannot be moved with a text replacement.")
          if (change.asset && change.content !== undefined) throw new FileStoreError("An image replacement cannot include text content.")
          if (change.asset && !(await tx.getAsset(this.projectId, change.asset.id))) throw new FileStoreError("Download this image before moving it.")
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
            ...(change.asset ? { kind: "image" as const, asset: change.asset, asset_id: change.asset.id } : {}),
            content: change.asset ? "" : change.content ?? source.content,
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
      const content = change.kind === "move" ? (change.content ?? before[index]?.content ?? "") : change.kind === "asset" ? "" : change.content
      const image = change.kind === "asset" ? change.asset : change.kind === "move" ? change.asset ?? (before[index]?.kind === "image" ? before[index]?.asset : null) : null
      results.push({ path, revision: image ? assetToken(image) : await contentToken(content), size: image?.byte_length ?? byteLength(content) })
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
    checkPath(path)
    await this.flushDrafts()
    // Parsing is deliberately outside IndexedDB: awaiting a parser or module
    // import inside a transaction would let the browser commit it early.
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.db.transaction(this.partition, "readonly", async (tx) => ({ project: await this.project(tx), files: await tx.listFiles(this.projectId) }))
      const file = snapshot.files.find(file => file.path === path)
      if (!file || !file.draft && !snapshot.files.some(candidate => candidate.draft?.asset?.draft_note === path)) return
      const planned = await discardedImageDependencies(snapshot.files, snapshot.project, file)
      if (planned.preserveTarget) return
      const applied = await this.db.transaction(this.partition, "readwrite", async (tx) => {
        const project = await this.project(tx)
        const current = await tx.listFiles(this.projectId)
        if (JSON.stringify(project) !== JSON.stringify(snapshot.project) || JSON.stringify(current) !== JSON.stringify(snapshot.files)) return false
        if (file.draft) {
          if (file.content === null && file.base === null && !project.pending?.files.some(pending => pending.localId === file.localId)) await tx.deleteFile(this.projectId, path)
          else await tx.putFile({ ...file, draft: null })
        }
        for (const removed of planned.remove) await tx.deleteFile(this.projectId, removed)
        for (const cleared of planned.clear) {
          const current = await tx.getFile(this.projectId, cleared)
          if (current) await tx.putFile({ ...current, draft: null })
        }
        const remaining = await tx.listFiles(this.projectId)
        const used = new Set(remaining.flatMap(file => [file.asset?.id, file.draft?.asset?.id, file.base?.asset?.id, file.conflict?.current?.asset?.id]).filter(Boolean))
        for (const pending of project.pending?.files ?? []) if (pending.asset?.id) used.add(pending.asset.id)
        for (const change of project.pending?.changes ?? []) if ("asset_id" in change && change.asset_id) used.add(change.asset_id)
        for (const id of planned.assets) {
          if (used.has(id)) continue
          const asset = await tx.getAsset(this.projectId, id)
          if (asset && !asset.uploaded && !asset.uploadAttempted) await tx.deleteAsset(this.projectId, id)
        }
        return true
      })
      if (applied) { this.emit(); return }
    }
    throw new FileStoreError("This project changed while discarding its draft. Try again.")
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
        if (file?.kind === "image") throw new FileStoreError(`${entry.path} is an image and cannot be edited as text.`)
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

/** Plan removal of new image dependencies while keeping every other source's references. */
async function discardedImageDependencies(files: LocalFile[], project: LocalProject, discarded: LocalFile): Promise<{ remove: string[]; clear: string[]; assets: string[]; preserveTarget: boolean }> {
  const candidates = new Set<string>()
  const protectedPaths = new Set<string>()
  const assets = new Set<string>(discarded.draft?.asset ? [discarded.draft.asset.id] : [])
  const pendingIds = new Set(project.pending?.files.map(file => file.localId))
  for (const file of files) if (file.draft?.asset?.draft_note === discarded.path) candidates.add(file.path)
  const remaining = files.filter(file => file.path !== discarded.path || file.content !== null || file.base !== null || pendingIds.has(file.localId)).map(file => file.path === discarded.path ? { ...file, draft: null } : file)
  const { parseImageReferences } = await import("../images/referenceParser")
  const references = async (path: string, source: string | null | undefined) => {
    if (source == null || !/\.mdx?$/i.test(path)) return []
    return (await parseImageReferences(source, /\.mdx$/i.test(path) ? "mdx" : "md", path)).map(reference => reference.path)
  }
  try {
    if (discarded.kind === "image") {
      candidates.add(discarded.path)
      if (discarded.draft?.asset?.original_path) candidates.add(discarded.draft.asset.original_path)
    }
    else for (const path of await references(discarded.path, discarded.draft?.content)) candidates.add(path)
    for (const file of remaining) {
      if (file.kind === "image") continue
      for (const [sourcePath, source] of [[file.path, file.content], [file.path, file.draft?.content], [file.base?.path ?? file.path, file.base?.content], [file.base?.path ?? file.path, file.conflict?.current?.content]] as const)
        for (const path of await references(sourcePath, source)) protectedPaths.add(path)
    }
    for (const pending of project.pending?.files ?? []) {
      if (pending.asset?.original_path) protectedPaths.add(pending.asset.original_path)
      if (pending.sentPath && pending.kind !== "image")
        for (const path of await references(pending.sentPath, pending.sentContent)) protectedPaths.add(path)
    }
    for (const change of project.pending?.changes ?? []) {
      if (change.op === "put" || change.op === "move" && change.content !== undefined)
        for (const path of await references(change.op === "move" ? change.to : change.path, change.content)) protectedPaths.add(path)
    }
  } catch {
    // A document being typed may not parse yet. Keep its possible dependencies.
    return { remove: [], clear: [], assets: [], preserveTarget: discarded.kind === "image" && discarded.content === null && discarded.base === null && !pendingIds.has(discarded.localId) }
  }
  const byPath = new Map(remaining.map(file => [file.path, file]))
  // An edited copy retains its original as a local dependency until saved.
  for (const path of candidates) {
    const original = byPath.get(path)?.draft?.asset?.original_path
    if (original) candidates.add(original)
  }
  for (const file of remaining) {
    if (file.kind !== "image") continue
    if (!candidates.has(file.path) || protectedPaths.has(file.path) || file.content !== null || file.base !== null) protectedPaths.add(file.path)
  }
  for (const path of protectedPaths) {
    const file = byPath.get(path)
    for (const asset of [file?.asset, file?.draft?.asset, file?.base?.asset, file?.conflict?.current?.asset]) if (asset?.original_path) protectedPaths.add(asset.original_path)
  }
  const remove: string[] = []
  const clear: string[] = []
  for (const path of candidates) {
    const file = byPath.get(path)
    if (!file || file.kind !== "image" || file.content !== null || file.base !== null || !file.draft || protectedPaths.has(path)) continue
    if (pendingIds.has(file.localId)) clear.push(path)
    else remove.push(path)
    if (file.draft.asset) assets.add(file.draft.asset.id)
  }
  return { remove, clear, assets: [...assets], preserveTarget: discarded.kind === "image" && discarded.content === null && discarded.base === null && !pendingIds.has(discarded.localId) && protectedPaths.has(discarded.path) }
}

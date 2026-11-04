import type { ProjectDatabase, StorageTransaction } from "./database"
import { safeSyncErrorDetail, stoppedSyncMessage } from "./syncDiagnostics"
import {
  canEdit,
  companionPaths,
  fileState,
  isDirty,
  MAX_ENTRIES,
  type FileConflict,
  type ImageAsset,
  type LocalFile,
  type LocalFolder,
  type LocalProject,
  type PendingSave,
  type SaveChange,
} from "./model"
import { RemoteError, type ProjectRemote, type RemoteProject, type SaveResult } from "./remote"

/**
 * Keeps projects on this device in step with the server.
 *
 * Sending: files saved together (one local save, or a D2 source with its
 * companions) go in one `save_files` call; everything else goes file by
 * file, so one stale file never blocks the rest. Each batch is stored with
 * its mutation id before it is sent, so a retry after a lost response gets
 * the original result instead of saving twice.
 *
 * Receiving: a project's `revision` is the highest server revision whose
 * changes this device has fully taken in. A pull reads the files changed and
 * deleted after it. Files with local changes are left alone (saving them
 * later ends in a conflict the person resolves), and anything left alone
 * holds `revision` below its version, so a later pull looks at it again.
 */

export type SyncOutcome =
  | { status: "synced"; projectId: string }
  | { status: "offline"; projectId: string; message: string }
  | { status: "incomplete"; projectId: string; message: string }
  | { status: "stopped"; projectId: string; reason: NonNullable<LocalProject["syncError"]>; message: string }

export type SyncEvent = { type: "changed"; projectId: string } | { type: "rekeyed"; projectId: string; newId: string }

export type Lock = <T>(name: string, work: () => Promise<T>) => Promise<T>

/** Serializes work per name across tabs with Web Locks, or within this tab when they are unavailable. */
export function defaultLock(): Lock {
  const local = new Map<string, Promise<unknown>>()
  return async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(name, work) as Promise<T>
    const previous = local.get(name) ?? Promise.resolve()
    const next = previous.then(work, work)
    local.set(name, next.catch(() => {}))
    return next
  }
}

export type DownloadOptions = {
  path?: string | null
  /** Display readiness, separate from the promise for complete offline preparation. */
  ready?: () => void | Promise<void>
  signal?: AbortSignal
}

export type ConflictChoice = "mine" | "theirs" | "both"

/** A guard against a bug turning one sync into an endless loop; normal syncs stop long before. */
const MAX_ROUNDS = 1000

export class ProjectSync {
  private listeners = new Set<(event: SyncEvent) => void>()
  private readonly imageTransfers = new Map<string, import("./cacheRemoteImages").ImageTransfer>()

  constructor(
    private readonly db: ProjectDatabase,
    private readonly remote: ProjectRemote,
    readonly partition: string,
    private readonly lock: Lock = defaultLock(),
  ) {}

  subscribe(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: SyncEvent) {
    for (const listener of this.listeners) listener(event)
  }

  private locked<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    return this.lock(`elaborating-sync:${this.partition}:${projectId}`, work)
  }

  listLocal(): Promise<LocalProject[]> {
    return this.db.listProjects(this.partition)
  }

  /** Remove a project and all of its files and folders from this device, waiting for any sync of it to finish. */
  async forget(projectId: string): Promise<void> {
    await this.locked(projectId, () => this.db.transaction(this.partition, "readwrite", (tx) => tx.deleteProject(projectId)))
    this.emit({ type: "changed", projectId })
  }

  /** A new project on this device. The server gets it on the next sync. */
  async createProject(title: string): Promise<LocalProject> {
    const project: LocalProject = {
      partition: this.partition,
      id: crypto.randomUUID(),
      title,
      pendingTitle: null,
      role: "owner",
      revision: 0,
      created: false,
      archivedAt: null,
      syncError: null,
      pending: null,
    }
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      if (await tx.getProject(project.id)) throw new Error("A project with this id is already on this device.")
      await tx.putProject(project)
    })
    this.emit({ type: "changed", projectId: project.id })
    return project
  }

  /** Rename a project on this device; the new title is sent on the next sync. */
  async rename(projectId: string, title: string): Promise<void> {
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      const project = await tx.getProject(projectId)
      if (!project) throw new Error("This project is not on this device.")
      if (!canEdit(project.role)) throw new Error("You can view this project but not change it.")
      await tx.putProject({ ...project, pendingTitle: title === project.title ? null : title })
    })
    this.emit({ type: "changed", projectId })
  }

  /** Clear a stopped sync (after the person fixed the cause) and sync again. */
  async retry(projectId: string, signal?: AbortSignal): Promise<SyncOutcome> {
    signal?.throwIfAborted()
    await this.updateProject(projectId, (project) => ({ ...project, syncError: null, syncErrorDetail: null }))
    this.emit({ type: "changed", projectId })
    return this.sync(projectId, signal)
  }

  /**
   * Refresh project details from the server and pull changes into the
   * projects on this device. Projects not yet on this device are only listed.
   */
  async refresh(): Promise<RemoteProject[]> {
    // Read before asking for the list: a project the server creates while the list is on its way is not in it.
    const local = (await this.db.listProjects(this.partition)).filter((project) => project.created)
    const remote = await this.remote.listProjects()
    const byId = new Map(remote.map((entry) => [entry.id, entry]))
    // A project no longer listed was deleted by its owner, or the person's access ended.
    const gone = local.filter((project) => !byId.has(project.id) && project.syncError !== "deleted").map((project) => project.id)
    const deleted = new Set(gone.length > 0 ? await this.remote.deletedProjects(gone) : [])
    for (const project of local) await this.takeDetails(project, byId.get(project.id) ?? null, deleted.has(project.id))
    return remote
  }

  /** Take in one project's details as the server just returned them (after archiving it, say), if it is on this device. */
  async adopt(entry: RemoteProject): Promise<void> {
    const local = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(entry.id))
    if (local?.created) await this.takeDetails(local, entry)
  }

  /** Update a project on this device from the server's details (none: access is gone, or with `deleted` the project), and pull what it lacks. */
  private async takeDetails(local: LocalProject, entry: RemoteProject | null, deleted = false): Promise<void> {
    await this.updateDetails(local.id, entry, deleted)
    if (entry && entry.revision > local.revision) await this.locked(local.id, () => this.pull(local.id, entry.revision))
  }

  /**
   * A project's title, role and archived state as the server lists them
   * (none: access is gone, or with `deleted` the project). Nothing when the
   * project has left this device since it was read, as when the person
   * removes it while a refresh is on its way.
   */
  private async updateDetails(projectId: string, entry: RemoteProject | null, deleted = false): Promise<void> {
    const updated = await this.updateProject(projectId, (current) => {
      if (!entry) return { ...current, syncError: deleted || current.syncError === "deleted" ? "deleted" : "access-lost", syncErrorDetail: null }
      const resumed = (current.syncError === "archived" && !entry.archived_at) || (current.syncError === "access-lost" && canEdit(entry.role))
      return {
        ...current,
        title: entry.title,
        pendingTitle: current.pendingTitle === entry.title ? null : current.pendingTitle,
        role: entry.role,
        archivedAt: entry.archived_at,
        syncError: resumed ? null : current.syncError,
        syncErrorDetail: resumed || current.syncError === null ? null : current.syncErrorDetail,
      }
    }, { ifPresent: true })
    if (updated) this.emit({ type: "changed", projectId })
  }

  /** Bring a project from the server onto this device. */
  async download(entry: RemoteProject, options: DownloadOptions = {}): Promise<LocalProject> {
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      if (await tx.getProject(entry.id)) return
      await tx.putProject({
        partition: this.partition,
        id: entry.id,
        title: entry.title,
        pendingTitle: null,
        role: entry.role,
        revision: 0,
        ...(entry.revision > 0 ? { partial: { revision: entry.revision, metadata: false } } : {}),
        created: true,
        archivedAt: entry.archived_at,
        syncError: null,
        pending: null,
      })
    })
    await this.locked(entry.id, () => this.pull(entry.id, entry.revision, options))
    const project = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(entry.id))
    if (!project) throw new Error("This project could not be kept on this device.")
    return project
  }

  /** Read a newly requested path without waiting for unrelated metadata or offline work. */
  async requestFile(projectId: string, path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const { project, file } = await this.db.transaction(this.partition, "readonly", async tx => ({ project: await tx.getProject(projectId), file: await tx.getFile(projectId, path) }))
    if (!project?.created || !project.partial || project.syncError === "access-lost" || project.syncError === "deleted") return
    if (file?.kind === "image" && file.asset && !file.draft?.asset) {
      await this.cacheRemoteImages(projectId, [file.asset], signal)
      return
    }
    if (project.partial.metadata || !this.remote.requestedFile) return
    const requested = await this.remote.requestedFile(projectId, path, project.partial.revision, signal)
    signal?.throwIfAborted()
    if (!requested) return
    const { applyRemoteFiles } = await import("./pullFiles")
    signal?.throwIfAborted()
    const applied = await this.db.transaction(this.partition, "readwrite", async tx => {
      signal?.throwIfAborted()
      const current = await tx.getProject(projectId)
      if (!current?.partial || current.partial.revision !== project.partial!.revision || current.pending || current.syncError === "access-lost" || current.syncError === "deleted") return false
      await applyRemoteFiles(tx, this.partition, projectId, [requested], [], current.revision)
      return true
    })
    if (!applied) return
    this.emit({ type: "changed", projectId })
    if (requested.kind === "image" && requested.asset) await this.cacheRemoteImages(projectId, [requested.asset], signal)
  }

  /**
   * Send this device's changes, then take in the server's. Serialized per
   * project across tabs. The outcome's projectId differs from the argument
   * when the project had to take a fresh id (see `rekeyed` events).
   */
  sync(projectId: string, signal?: AbortSignal): Promise<SyncOutcome> {
    return this.locked(projectId, async () => {
      signal?.throwIfAborted()
      const outcome = await this.push(projectId)
      // A sent mutation is acknowledged durably before optional pull cancellation.
      signal?.throwIfAborted()
      // Refused, or no longer listed (below): the owner may have deleted the project.
      if (outcome.status === "stopped" && outcome.reason === "access-lost") return (await this.deletedOutcome(outcome.projectId)) ?? outcome
      if (outcome.status !== "synced") return outcome
      try {
        const entry = (await this.remote.listProjects(signal)).find((candidate) => candidate.id === outcome.projectId)
        if (entry) {
          // The role and archived state follow too, so a new role or an unarchive shows without waiting for a refresh.
          await this.updateDetails(outcome.projectId, entry)
          await this.pull(outcome.projectId, entry.revision, { signal })
        } else {
          // No longer listed: its owner deleted it, or, as `refresh()` finds, the person's access ended.
          const deleted = await this.deletedOutcome(outcome.projectId)
          if (deleted) return deleted
          await this.updateDetails(outcome.projectId, null)
          return { status: "stopped", projectId: outcome.projectId, reason: "access-lost", message: stoppedSyncMessage("access-lost") }
        }
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof RemoteError && error.kind === "network") return { status: "offline", projectId: outcome.projectId, message: error.message }
        throw error
      }
      return outcome
    })
  }

  /** When the project's owner deleted it: marks it so, and says so; else (or offline) null. */
  private async deletedOutcome(projectId: string): Promise<SyncOutcome | null> {
    const project = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(projectId))
    if (!project?.created) return null
    let deleted: string[]
    try {
      deleted = await this.remote.deletedProjects([projectId])
    } catch (error) {
      if (error instanceof RemoteError && error.kind === "network") return null
      throw error
    }
    if (!deleted.includes(projectId)) return null
    await this.updateDetails(projectId, null, true)
    return { status: "stopped", projectId, reason: "deleted", message: stoppedSyncMessage("deleted") }
  }

  private async push(startId: string): Promise<SyncOutcome> {
    let projectId = startId
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const step = await this.db.transaction(this.partition, "readwrite", async (tx) => {
        const project = await tx.getProject(projectId)
        if (!project) throw new Error("This project is not on this device.")
        if (project.syncError) return { kind: "stopped" as const, reason: project.syncError, detail: project.syncErrorDetail }
        if (!project.created) return { kind: "create" as const, title: project.pendingTitle ?? project.title }
        if (project.pending) return { kind: "send" as const, pending: project.pending }
        if (project.pendingTitle !== null) return { kind: "rename" as const, title: project.pendingTitle }
        if (!canEdit(project.role)) return { kind: "done" as const }
        const pending = await nextBatch(tx, project)
        if (!pending) return { kind: "done" as const }
        await tx.putProject({ ...project, pending })
        return { kind: "send" as const, pending }
      })

      if (step.kind === "done") return { status: "synced", projectId }
      if (step.kind === "stopped") return { status: "stopped", projectId, reason: step.reason, message: stoppedSyncMessage(step.reason, step.detail) }
      try {
        if (step.kind === "create") {
          let summary: RemoteProject
          try {
            summary = await this.remote.createProject(projectId, step.title)
          } catch (error) {
            if (!(error instanceof RemoteError) || error.kind !== "unavailable") throw error
            const newId = await this.rekey(projectId)
            this.emit({ type: "rekeyed", projectId, newId })
            projectId = newId
            continue
          }
          // A retried create returns the project as first created; keep any later title pending.
          await this.updateProject(projectId, (project) => {
            const wanted = project.pendingTitle ?? project.title
            return {
              ...project,
              created: true,
              title: summary.title,
              pendingTitle: wanted === summary.title ? null : wanted,
              role: summary.role ?? project.role,
              archivedAt: summary.archived_at,
            }
          })
        } else if (step.kind === "rename") {
          const summary = await this.remote.renameProject(projectId, step.title)
          await this.updateProject(projectId, (project) => ({
            ...project,
            title: summary.title,
            pendingTitle: project.pendingTitle === step.title ? null : project.pendingTitle,
            // A rename is a revision of its own; nothing else changed if it directly follows ours.
            revision: project.revision === summary.revision - 1 ? summary.revision : project.revision,
          }))
        } else {
          step.pending = await this.uploadPendingImages(projectId, step.pending)
          const result = await this.remote.saveFiles(projectId, step.pending.mutationId, step.pending.changes)
          if (result.status === "conflict") await this.cacheRemoteImages(projectId, result.conflicts.flatMap((conflict) => conflict.current?.asset ? [conflict.current.asset] : []))
          await this.acknowledge(projectId, step.pending, result)
        }
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error
        const stopped = await this.handleError(projectId, step.kind === "send" ? step.pending : null, error)
        if (stopped) return stopped
      }
      this.emit({ type: "changed", projectId })
    }
    return { status: "incomplete", projectId, message: "More changes are waiting. Sync again to send them." }
  }

  private async handleError(projectId: string, pending: PendingSave | null, error: RemoteError): Promise<SyncOutcome | null> {
    if (error.kind === "image-expired") return null
    if (error.kind === "network") return { status: "offline", projectId, message: error.message }
    // A per-account limit resets with time: keep the batch, with its mutation id, for the next sync.
    if (error.kind === "account-limit") return { status: "incomplete", projectId, message: error.message }
    if (error.kind === "path-taken" && pending && (await this.markPathTaken(projectId, pending, error.detail))) return null
    const reason: NonNullable<LocalProject["syncError"]> =
      error.kind === "access" ? "access-lost" : error.kind === "archived" ? "archived" : error.kind === "limit" ? "limit" : "invalid"
    const detail = reason === "invalid" || reason === "limit" ? safeSyncErrorDetail(error.message) : null
    await this.updateProject(projectId, (project) => ({
      ...project,
      syncError: reason,
      syncErrorDetail: detail,
      archivedAt: reason === "archived" ? (project.archivedAt ?? new Date().toISOString()) : project.archivedAt,
      // Access may come back; keep the batch so it is retried with the same mutation id.
      pending: reason === "access-lost" ? project.pending : null,
    }))
    this.emit({ type: "changed", projectId })
    return { status: "stopped", projectId, reason, message: stoppedSyncMessage(reason, detail) }
  }

  /** Change a project on this device; true when it did. Missing, it throws, or with `ifPresent` changes nothing. */
  private async updateProject(projectId: string, change: (project: LocalProject) => LocalProject, { ifPresent = false } = {}): Promise<boolean> {
    return this.db.transaction(this.partition, "readwrite", async (tx) => {
      const project = await tx.getProject(projectId)
      if (!project) {
        if (ifPresent) return false
        throw new Error("This project is not on this device.")
      }
      await tx.putProject(change(project))
      return true
    })
  }

  /** Give a local project a fresh id, keeping all its files. Used when the server says the id is taken. */
  private async rekey(oldId: string): Promise<string> {
    const newId = crypto.randomUUID()
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      const project = await tx.getProject(oldId)
      if (!project) throw new Error("This project is not on this device.")
      const files = await tx.listFiles(oldId)
      const folders = await tx.listFolders(oldId)
      const assets = await tx.listAssets(oldId)
      await tx.deleteProject(oldId)
      await tx.putProject({ ...project, id: newId })
      for (const file of files) await tx.putFile({ ...file, projectId: newId })
      for (const folder of folders) await tx.putFolder({ ...folder, projectId: newId })
      for (const asset of assets) await tx.putAsset({ ...asset, projectId: newId, uploaded: false })
    })
    return newId
  }

  private async uploadPendingImages(projectId: string, pending: PendingSave): Promise<PendingSave> {
    if (!pending.changes.some(change => change.op === "asset" || change.op === "move" && change.asset_id)) return pending
    const { ImageUploads } = await import("./uploadImages")
    return new ImageUploads(this.db, this.remote, this.partition).uploadPendingImages(projectId, pending)
  }

  /** Cache originals and previews before a remote revision is considered available offline. */
  private async cacheRemoteImages(projectId: string, assets: ImageAsset[], signal?: AbortSignal): Promise<void> {
    if (assets.length === 0) return
    const { cacheRemoteImages } = await import("./cacheRemoteImages")
    await cacheRemoteImages(this.db, this.remote, this.partition, projectId, assets, () => this.emit({type: "changed", projectId}), signal, this.imageTransfers)
  }

  private async acknowledge(projectId: string, pending: PendingSave, result: SaveResult): Promise<void> {
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      const project = await tx.getProject(projectId)
      if (!project || project.pending?.mutationId !== pending.mutationId) return
      const files = new Map((await tx.listFiles(projectId)).map((file) => [file.localId, file]))

      if (result.status === "saved") {
        for (const [index, entry] of pending.files.entries()) {
          const file = files.get(entry.localId)
          if (!file) continue
          const applied = result.changes[index]
          const savedAsset = entry.asset ? (await tx.getAsset(projectId, entry.asset.id))?.asset ?? entry.asset : null
          const base =
            entry.sentPath === null || !applied?.id || !applied.version
              ? null
              : { id: applied.id, path: entry.sentPath, version: applied.version, content: entry.sentContent ?? "", ...(entry.kind === "image" ? { kind: "image" as const, asset_id: savedAsset?.id ?? null, asset: savedAsset } : {}) }
          const next: LocalFile = { ...file, base, conflict: null }
          if (base === null && next.content === null) {
            // Deleted on both sides; keep only an unsaved draft, if any.
            if (next.draft) await tx.putFile({ ...next, batch: null })
            else await tx.deleteFile(projectId, file.path)
            continue
          }
          await tx.putFile({ ...next, batch: isDirty(next) ? next.batch : null })
        }
        const folders = await tx.listFolders(projectId)
        for (const sent of pending.folders) {
          const folder = folders.find((candidate) => candidate.path === sent.path)
          if (!folder) continue
          if (!sent.local && !folder.local) await tx.deleteFolder(projectId, folder.path)
          else await tx.putFolder({ ...folder, base: sent.local, batch: folder.local === sent.local ? null : folder.batch })
        }
        await tx.putProject({
          ...project,
          pending: null,
          // Our save is the only change in its revision; if we had the one before, we have this one.
          revision: project.revision === result.project.revision - 1 ? result.project.revision : project.revision,
        })
        return
      }

      // Conflicts: record on each file what the server has; nothing was saved.
      const marks = new Map<string, { current: FileConflict["current"]; pathTaken: boolean; stale: boolean }>()
      for (const conflict of result.conflicts) {
        const index = pending.changes.findIndex(
          (change) => change.path === conflict.path || (change.op === "move" && change.to === conflict.path),
        )
        const entry = index >= 0 ? pending.files[index] : undefined
        const file = entry ? files.get(entry.localId) : undefined
        if (!entry || !file) continue
        const change = pending.changes[index]
        const mark = marks.get(entry.localId) ?? { current: null, pathTaken: false, stale: false }
        if (change.op === "move" && change.to === conflict.path) mark.pathTaken = true
        else {
          mark.stale = true
          mark.current = conflict.current
        }
        marks.set(entry.localId, mark)
      }
      if (marks.size === 0) {
        // Every conflict names a file in the batch; if none does, retrying would repeat this forever.
        await tx.putProject({ ...project, pending: null, syncError: "invalid", syncErrorDetail: "The server returned an unrecognized save conflict." })
        return
      }
      for (const [localId, mark] of marks) {
        const file = files.get(localId)!
        // Only the path is taken: the server's copy of this file is still the one this device has.
        const current = mark.stale ? mark.current : file.base ? { id: file.base.id, version: file.base.version, content: file.base.content, ...(file.base.kind === "image" ? { kind: "image" as const, asset_id: file.base.asset_id, asset: file.base.asset } : {}) } : null
        await tx.putFile({ ...file, conflict: { current, pathTaken: mark.pathTaken } })
      }
      await tx.putProject({ ...project, pending: null })
    })
  }

  /**
   * The server refused a save because a path it adds is taken (`detail` names
   * it). A file that wanted the path is marked; a folder that wanted it is
   * dropped, since an empty folder holds nothing to lose. False when nothing
   * in the batch matches, so sync stops instead of retrying forever.
   */
  private async markPathTaken(projectId: string, pending: PendingSave, detail: string | null): Promise<boolean> {
    return this.db.transaction(this.partition, "readwrite", async (tx) => {
      const project = await tx.getProject(projectId)
      if (!project || project.pending?.mutationId !== pending.mutationId || detail === null) return false
      const entry = pending.files.find((candidate) => candidate.sentPath === detail)
      const file = entry && (await tx.listFiles(projectId)).find((candidate) => candidate.localId === entry.localId)
      const folder = pending.folders.some((candidate) => candidate.path === detail && candidate.local)
        ? (await tx.listFolders(projectId)).find((candidate) => candidate.path === detail)
        : undefined
      if (file) {
        const current = file.base ? { id: file.base.id, version: file.base.version, content: file.base.content, ...(file.base.kind === "image" ? { kind: "image" as const, asset_id: file.base.asset_id, asset: file.base.asset } : {}) } : null
        await tx.putFile({ ...file, conflict: { current, pathTaken: true } })
      } else if (folder) {
        if (folder.base) await tx.putFolder({ ...folder, local: true })
        else await tx.deleteFolder(projectId, folder.path)
      } else {
        return false
      }
      await tx.putProject({ ...project, pending: null })
      return true
    })
  }

  /** Take in the server's changes after this device's revision, up to `remoteRevision`. Call under the project lock. */
  private async pull(projectId: string, remoteRevision: number, options: DownloadOptions = {}): Promise<void> {
    const { signal } = options
    signal?.throwIfAborted()
    const project = await this.db.transaction(this.partition, "readonly", tx => tx.getProject(projectId))
    // A batch in flight is settled by push, before pulling authoritative copies.
    if (!project?.created || project.pending) {
      await options.ready?.()
      return
    }
    if (remoteRevision <= project.revision) {
      // A legacy revision-zero row was conservatively marked unknown during
      // upgrade. The authenticated catalog confirms that it is truly empty.
      if (project.partial && project.revision === 0 && remoteRevision === 0) {
        await this.updateProject(projectId, current => {
          const complete = { ...current }
          delete complete.partial
          return complete
        })
        this.emit({ type: "changed", projectId })
      }
      await options.ready?.()
      return
    }
    const since = project.revision
    await this.updateProject(projectId, current => ({ ...current, partial: { revision: remoteRevision, metadata: false } }))
    const metadata = Promise.all([
      this.remote.changedFiles(projectId, since, remoteRevision, signal),
      this.remote.deletedFiles(projectId, since, remoteRevision, signal),
      this.remote.folders(projectId, signal),
    ])
    // A failure remains observed while the independent requested-file read runs.
    void metadata.catch(() => {})
    const applying = import("./pullFiles")
    void applying.catch(() => {})
    let shown = false
    const ready = async () => {
      if (shown) return
      signal?.throwIfAborted()
      shown = true
      await options.ready?.()
    }
    if (options.path && this.remote.requestedFile) {
      const requested = await this.remote.requestedFile(projectId, options.path, remoteRevision, signal)
      signal?.throwIfAborted()
      if (requested) {
        const { applyRemoteFiles } = await applying
        await this.db.transaction(this.partition, "readwrite", async tx => {
          signal?.throwIfAborted()
          const current = await tx.getProject(projectId)
          if (!current || current.revision !== since || current.pending) return
          await applyRemoteFiles(tx, this.partition, projectId, [requested], [], since)
        })
        this.emit({ type: "changed", projectId })
        if (requested.kind === "image" && requested.asset) await this.cacheRemoteImages(projectId, [requested.asset], signal)
        await ready()
      }
    }
    const [changed, deleted, folders] = await metadata
    const { applyRemoteFiles, applyRemoteFolders } = await applying
    signal?.throwIfAborted()
    const published = await this.db.transaction(this.partition, "readwrite", async tx => {
      signal?.throwIfAborted()
      const current = await tx.getProject(projectId)
      if (!current || current.revision !== since || current.pending) return false
      await applyRemoteFiles(tx, this.partition, projectId, changed, deleted, since)
      await applyRemoteFolders(tx, this.partition, projectId, folders)
      await tx.putProject({ ...current, partial: { revision: remoteRevision, metadata: true } })
      return true
    })
    if (!published) return
    this.emit({ type: "changed", projectId })
    await ready()
    await this.cacheRemoteImages(projectId, changed.flatMap(file => file.kind === "image" && file.asset ? [file.asset] : []), signal)
    const latest = (await this.remote.listProjects(signal)).find(entry => entry.id === projectId)
    signal?.throwIfAborted()
    if (!latest) {
      if (!await this.deletedOutcome(projectId)) await this.updateDetails(projectId, null)
      throw new RemoteError("access", "Your access to this project ended while its offline copy was being prepared.")
    }
    await this.updateDetails(projectId, latest)
    const applied = await this.db.transaction(this.partition, "readwrite", async tx => {
      signal?.throwIfAborted()
      const current = await tx.getProject(projectId)
      if (!current || current.revision !== since || current.pending) return false
      const reached = await applyRemoteFiles(tx, this.partition, projectId, changed, deleted, remoteRevision)
      await applyRemoteFolders(tx, this.partition, projectId, folders)
      const complete = { ...current, revision: Math.max(since, reached) }
      delete complete.partial
      await tx.putProject(complete)
      return true
    })
    if (applied) this.emit({ type: "changed", projectId })
  }

  /**
   * Settle a conflicted file.
   * - mine: keep this device's version; the next sync replaces the server's.
   *   Not possible when the path is taken: move the file to another path instead.
   * - theirs: take the server's copy and drop this device's changes to the file.
   * - both: keep this device's version as a new file next to it, and take the server's.
   */
  async resolve(projectId: string, path: string, choice: ConflictChoice): Promise<void> {
    await this.locked(projectId, () =>
      this.db.transaction(this.partition, "readwrite", async (tx) => {
        const file = await tx.getFile(projectId, path)
        if (!file?.conflict) throw new Error(`${path} has no conflict to resolve.`)
        const { current, pathTaken } = file.conflict
        if (choice === "mine") {
          if (pathTaken) throw new Error(`${path} is taken on the server. Keep both, or move the file to another path.`)
          const serverPath = file.base?.path ?? file.path
          const base = current ? { id: current.id, path: serverPath, version: current.version, content: current.content, ...(current.kind === "image" ? { kind: "image" as const, asset_id: current.asset_id, asset: current.asset } : {}) } : null
          if (base === null && file.content === null) {
            if (file.draft) await tx.putFile({ ...file, base: null, conflict: null, batch: null })
            else await tx.deleteFile(projectId, file.path)
          } else {
            await tx.putFile({ ...file, base, conflict: null })
          }
          return
        }
        if (choice === "both" && file.content !== null) {
          await tx.putFile({
            ...file,
            localId: crypto.randomUUID(),
            path: await copyPath(tx, projectId, file.path),
            base: null,
            batch: null,
            draft: null,
            conflict: null,
          })
        }
        await takeTheirs(tx, projectId, file, current)
      }),
    )
    this.emit({ type: "changed", projectId })
  }
}

/** The next group of changes to send, or null when everything is synced. */
async function nextBatch(tx: StorageTransaction, project: LocalProject): Promise<PendingSave | null> {
  const files = await tx.listFiles(project.id)
  const folders = (await tx.listFolders(project.id)).filter((folder) => folder.local !== folder.base)
  const folderChange = (folder: LocalFolder): SaveChange => ({ op: folder.local ? "mkdir" : "rmdir", path: folder.path })
  for (const group of groupFiles(files)) {
    if (group.some((file) => file.conflict !== null)) continue
    const members = group.filter(isDirty)
    if (members.length === 0) continue
    // Folders made or removed in the same local save (a folder move) go in the same change.
    const batches = new Set(group.flatMap((file) => (file.batch === null ? [] : [file.batch])))
    const withFiles = folders.filter((folder) => folder.batch !== null && batches.has(folder.batch))
    if (members.length + withFiles.length > MAX_ENTRIES) throw new Error("Too many files were changed together to sync at once.")
    return {
      mutationId: crypto.randomUUID(),
      changes: [...members.map(changeFor), ...withFiles.map(folderChange)],
      files: members.map((file) => ({
        localId: file.localId,
        sentPath: file.content === null ? null : file.path,
        sentContent: file.content,
        ...(file.kind === "image" ? { kind: "image" as const, asset_id: file.asset?.id ?? null, asset: file.asset } : {}),
      })),
      folders: withFiles.map((folder) => ({ path: folder.path, local: folder.local })),
    }
  }
  // A folder saved with files waits for them, so the server never has one without the other.
  const waiting = new Set(files.flatMap((file) => (file.batch !== null && (isDirty(file) || file.conflict !== null) ? [file.batch] : [])))
  const alone = folders.filter((folder) => folder.batch === null || !waiting.has(folder.batch)).slice(0, MAX_ENTRIES)
  if (alone.length === 0) return null
  return {
    mutationId: crypto.randomUUID(),
    changes: alone.map(folderChange),
    files: [],
    folders: alone.map((folder) => ({ path: folder.path, local: folder.local })),
  }
}

/**
 * Groups of files that must sync together: files from one local save, and
 * D2 sources with their companions. Groups that free a path (a delete or a
 * move) go first, so a later group can reuse it.
 */
function groupFiles(files: LocalFile[]): LocalFile[][] {
  const relevant = files.filter((file) => isDirty(file) || file.conflict !== null)
  const parent = new Map(relevant.map((file) => [file.localId, file.localId]))
  const find = (id: string): string => {
    const next = parent.get(id)!
    if (next === id) return id
    const root = find(next)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  const byBatch = new Map<string, string>()
  const byPath = new Map(relevant.map((file) => [file.path, file.localId]))
  for (const file of relevant) {
    if (file.batch) {
      const first = byBatch.get(file.batch)
      if (first) union(file.localId, first)
      else byBatch.set(file.batch, file.localId)
    }
    for (const companion of companionPaths(file.path)) {
      const other = byPath.get(companion)
      if (other) union(file.localId, other)
    }
  }
  const groups = new Map<string, LocalFile[]>()
  for (const file of relevant) {
    const root = find(file.localId)
    groups.set(root, [...(groups.get(root) ?? []), file])
  }
  const frees = (group: LocalFile[]) => group.some((file) => fileState(file) === "deleted" || fileState(file) === "moved")
  const first = (group: LocalFile[]) => group.map((file) => file.path).sort()[0]
  return [...groups.values()].sort((a, b) => {
    if (frees(a) !== frees(b)) return frees(a) ? -1 : 1
    return first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0
  })
}

function changeFor(file: LocalFile): SaveChange {
  const base = file.base
  switch (fileState(file)) {
    case "created":
      return file.kind === "image" && file.asset ? { op: "asset", path: file.path, asset_id: file.asset.id } : { op: "put", path: file.path, content: file.content! }
    case "changed":
      return file.kind === "image" && file.asset ? { op: "asset", path: file.path, asset_id: file.asset.id, base_version: base!.version } : { op: "put", path: file.path, content: file.content!, base_version: base!.version }
    case "moved":
      return {
        op: "move",
        path: base!.path,
        to: file.path,
        base_version: base!.version,
        ...(file.kind === "image" && file.asset && file.asset.id !== base!.asset?.id ? { asset_id: file.asset.id } : file.content !== base!.content ? { content: file.content! } : {}),
      }
    case "deleted":
      return { op: "delete", path: base!.path, base_version: base!.version }
    case "clean":
      throw new Error("A clean file has nothing to send.")
  }
}

/** Drop this device's changes to a conflicted file and take the server's copy (or its absence). */
async function takeTheirs(tx: StorageTransaction, projectId: string, file: LocalFile, current: FileConflict["current"]) {
  await tx.deleteFile(projectId, file.path)
  if (current === null) return
  const serverPath = file.base?.path ?? file.path
  const occupant = await tx.getFile(projectId, serverPath)
  if (occupant) throw new Error(`${serverPath} is used by another file on this device. Move that file first.`)
  await tx.putFile({
    ...file,
    path: serverPath,
    base: { id: current.id, path: serverPath, version: current.version, content: current.content, ...(current.kind === "image" ? { kind: "image" as const, asset_id: current.asset_id, asset: current.asset } : {}) },
    content: current.content,
    kind: current.kind ?? "text",
    asset_id: current.asset_id ?? null,
    asset: current.asset ?? null,
    batch: null,
    draft: null,
    conflict: null,
  })
}

/** A free sibling path for a kept copy: "notes/a (my copy).md", then "(my copy 2)" and so on. */
async function copyPath(tx: StorageTransaction, projectId: string, path: string): Promise<string> {
  const slash = path.lastIndexOf("/")
  const dir = path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.indexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  for (let n = 1; n < 1000; n++) {
    const candidate = `${dir}${stem} (my copy${n > 1 ? ` ${n}` : ""})${extension}`
    if (!(await tx.getFile(projectId, candidate))) return candidate
  }
  throw new Error("Could not find a free name for the copy.")
}

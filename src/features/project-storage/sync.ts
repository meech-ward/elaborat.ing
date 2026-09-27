import type { ProjectDatabase, StorageTransaction } from "./database"
import {
  canEdit,
  companionPaths,
  fileState,
  isDirty,
  MAX_ENTRIES,
  type FileConflict,
  type LocalFile,
  type LocalFolder,
  type LocalProject,
  type PendingSave,
  type SaveChange,
} from "./model"
import { RemoteError, type DeletedFile, type ProjectRemote, type RemoteFile, type RemoteProject, type SaveResult } from "./remote"

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

export type ConflictChoice = "mine" | "theirs" | "both"

/** A guard against a bug turning one sync into an endless loop; normal syncs stop long before. */
const MAX_ROUNDS = 1000

export class ProjectSync {
  private listeners = new Set<(event: SyncEvent) => void>()

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
  async retry(projectId: string): Promise<SyncOutcome> {
    await this.updateProject(projectId, (project) => ({ ...project, syncError: null }))
    return this.sync(projectId)
  }

  /**
   * Refresh project details from the server and pull changes into the
   * projects on this device. Projects not yet on this device are only listed.
   */
  async refresh(): Promise<RemoteProject[]> {
    const remote = await this.remote.listProjects()
    const byId = new Map(remote.map((entry) => [entry.id, entry]))
    for (const local of await this.db.listProjects(this.partition)) {
      if (!local.created) continue
      await this.takeDetails(local, byId.get(local.id) ?? null)
    }
    return remote
  }

  /** Take in one project's details as the server just returned them (after archiving it, say), if it is on this device. */
  async adopt(entry: RemoteProject): Promise<void> {
    const local = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(entry.id))
    if (local?.created) await this.takeDetails(local, entry)
  }

  /** Update a project on this device from the server's details (none: access is gone), and pull what it lacks. */
  private async takeDetails(local: LocalProject, entry: RemoteProject | null): Promise<void> {
    await this.updateDetails(local.id, entry)
    if (entry && entry.revision > local.revision) await this.locked(local.id, () => this.pull(local.id, entry.revision))
  }

  /** A project's title, role and archived state as the server lists them (none: access is gone). */
  private async updateDetails(projectId: string, entry: RemoteProject | null): Promise<void> {
    await this.updateProject(projectId, (current) => {
      if (!entry) return { ...current, syncError: "access-lost" }
      return {
        ...current,
        title: entry.title,
        pendingTitle: current.pendingTitle === entry.title ? null : current.pendingTitle,
        role: entry.role,
        archivedAt: entry.archived_at,
        syncError:
          (current.syncError === "archived" && !entry.archived_at) || (current.syncError === "access-lost" && canEdit(entry.role))
            ? null
            : current.syncError,
      }
    })
    this.emit({ type: "changed", projectId })
  }

  /** Bring a project from the server onto this device. */
  async download(entry: RemoteProject): Promise<LocalProject> {
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      if (await tx.getProject(entry.id)) return
      await tx.putProject({
        partition: this.partition,
        id: entry.id,
        title: entry.title,
        pendingTitle: null,
        role: entry.role,
        revision: 0,
        created: true,
        archivedAt: entry.archived_at,
        syncError: null,
        pending: null,
      })
    })
    await this.locked(entry.id, () => this.pull(entry.id, entry.revision))
    const project = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(entry.id))
    if (!project) throw new Error("This project could not be kept on this device.")
    return project
  }

  /**
   * Send this device's changes, then take in the server's. Serialized per
   * project across tabs. The outcome's projectId differs from the argument
   * when the project had to take a fresh id (see `rekeyed` events).
   */
  sync(projectId: string): Promise<SyncOutcome> {
    return this.locked(projectId, async () => {
      const outcome = await this.push(projectId)
      if (outcome.status !== "synced") return outcome
      try {
        const entry = (await this.remote.listProjects()).find((candidate) => candidate.id === outcome.projectId)
        if (entry) {
          // The role and archived state follow too, so a new role or an unarchive shows without waiting for a refresh.
          await this.updateDetails(outcome.projectId, entry)
          await this.pull(outcome.projectId, entry.revision)
        }
      } catch (error) {
        if (error instanceof RemoteError && error.kind === "network") return { status: "offline", projectId: outcome.projectId, message: error.message }
        throw error
      }
      return outcome
    })
  }

  private async push(startId: string): Promise<SyncOutcome> {
    let projectId = startId
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const step = await this.db.transaction(this.partition, "readwrite", async (tx) => {
        const project = await tx.getProject(projectId)
        if (!project) throw new Error("This project is not on this device.")
        if (project.syncError) return { kind: "stopped" as const, reason: project.syncError }
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
      if (step.kind === "stopped") return { status: "stopped", projectId, reason: step.reason, message: stopMessage(step.reason) }
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
          const result = await this.remote.saveFiles(projectId, step.pending.mutationId, step.pending.changes)
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
    if (error.kind === "network") return { status: "offline", projectId, message: error.message }
    // A per-account limit resets with time: keep the batch, with its mutation id, for the next sync.
    if (error.kind === "account-limit") return { status: "incomplete", projectId, message: error.message }
    if (error.kind === "path-taken" && pending && (await this.markPathTaken(projectId, pending, error.detail))) return null
    const reason: NonNullable<LocalProject["syncError"]> =
      error.kind === "access" ? "access-lost" : error.kind === "archived" ? "archived" : error.kind === "limit" ? "limit" : "invalid"
    await this.updateProject(projectId, (project) => ({
      ...project,
      syncError: reason,
      archivedAt: reason === "archived" ? (project.archivedAt ?? new Date().toISOString()) : project.archivedAt,
      // Access may come back; keep the batch so it is retried with the same mutation id.
      pending: reason === "access-lost" ? project.pending : null,
    }))
    this.emit({ type: "changed", projectId })
    return { status: "stopped", projectId, reason, message: stopMessage(reason, error.message) }
  }

  private async updateProject(projectId: string, change: (project: LocalProject) => LocalProject): Promise<void> {
    await this.db.transaction(this.partition, "readwrite", async (tx) => {
      const project = await tx.getProject(projectId)
      if (!project) throw new Error("This project is not on this device.")
      await tx.putProject(change(project))
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
      await tx.deleteProject(oldId)
      await tx.putProject({ ...project, id: newId })
      for (const file of files) await tx.putFile({ ...file, projectId: newId })
      for (const folder of folders) await tx.putFolder({ ...folder, projectId: newId })
    })
    return newId
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
          const base =
            entry.sentPath === null || !applied?.id || !applied.version
              ? null
              : { id: applied.id, path: entry.sentPath, version: applied.version, content: entry.sentContent ?? "" }
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
        await tx.putProject({ ...project, pending: null, syncError: "invalid" })
        return
      }
      for (const [localId, mark] of marks) {
        const file = files.get(localId)!
        // Only the path is taken: the server's copy of this file is still the one this device has.
        const current = mark.stale ? mark.current : file.base ? { id: file.base.id, version: file.base.version, content: file.base.content } : null
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
        const current = file.base ? { id: file.base.id, version: file.base.version, content: file.base.content } : null
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
  private async pull(projectId: string, remoteRevision: number): Promise<void> {
    const project = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(projectId))
    // A batch in flight is settled by the next push; pulling first would mistake it for someone else's change.
    if (!project?.created || project.pending || remoteRevision <= project.revision) return
    const since = project.revision
    const [changed, deleted, folders] = await Promise.all([
      this.remote.changedFiles(projectId, since, remoteRevision),
      this.remote.deletedFiles(projectId, since, remoteRevision),
      this.remote.folders(projectId),
    ])
    const applied = await this.db.transaction(this.partition, "readwrite", async (tx) => {
      const current = await tx.getProject(projectId)
      if (!current || current.revision !== since || current.pending) return false
      const reached = await applyRemoteFiles(tx, this.partition, projectId, changed, deleted, remoteRevision)
      await applyRemoteFolders(tx, this.partition, projectId, folders)
      await tx.putProject({ ...current, revision: Math.max(since, reached) })
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
          const base = current ? { id: current.id, path: serverPath, version: current.version, content: current.content } : null
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

function stopMessage(reason: NonNullable<LocalProject["syncError"]>, detail?: string): string {
  switch (reason) {
    case "access-lost":
      return "You can no longer change this project. Your work stays on this device."
    case "archived":
      return "This project is archived. Unarchive it to sync your changes."
    case "limit":
      return detail ?? "This project is over its limits."
    case "invalid":
      return `The server refused these changes${detail ? `: ${detail}` : "."}`
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
      return { op: "put", path: file.path, content: file.content! }
    case "changed":
      return { op: "put", path: file.path, content: file.content!, base_version: base!.version }
    case "moved":
      return {
        op: "move",
        path: base!.path,
        to: file.path,
        base_version: base!.version,
        ...(file.content !== base!.content ? { content: file.content! } : {}),
      }
    case "deleted":
      return { op: "delete", path: base!.path, base_version: base!.version }
    case "clean":
      throw new Error("A clean file has nothing to send.")
  }
}

const isDraftOnly = (file: LocalFile) => file.base === null && file.content === null

/**
 * Apply the server's changed and deleted files. Only files without local
 * changes are touched. Returns the revision this device has now fully taken
 * in: `until`, or lower when something had to be left for a later pull.
 */
async function applyRemoteFiles(
  tx: StorageTransaction,
  partition: string,
  projectId: string,
  changed: RemoteFile[],
  deleted: DeletedFile[],
  until: number,
): Promise<number> {
  let reached = until
  const hold = (version: number) => {
    reached = Math.min(reached, version - 1)
  }

  for (const gone of deleted) {
    const local = await tx.findFileByBaseId(projectId, gone.id)
    if (!local) continue
    if (isDirty(local) || local.conflict !== null) {
      hold(gone.version)
      continue
    }
    if (local.draft) await tx.putFile({ ...local, base: null, content: null, batch: null })
    else await tx.deleteFile(projectId, local.path)
  }

  // Plan every placement before writing, so a file that cannot be placed stays where it was.
  type Plan = { remote: RemoteFile; local: LocalFile | null; occupant: LocalFile | null }
  const plans: Plan[] = []
  for (const remote of changed) {
    const local = await tx.findFileByBaseId(projectId, remote.id)
    if (local && (isDirty(local) || local.conflict !== null)) {
      hold(remote.version)
      continue
    }
    if (local && local.base!.version === remote.version && local.path === remote.path) continue
    const found = await tx.getFile(projectId, remote.path)
    plans.push({ remote, local, occupant: found && found.localId !== local?.localId ? found : null })
  }
  const failed = new Set<Plan>()
  for (let settled = false; !settled; ) {
    settled = true
    const vacated = new Set(plans.filter((plan) => plan.local && !failed.has(plan)).map((plan) => plan.local!.path))
    const claimed = new Set<string>()
    for (const plan of plans) {
      if (failed.has(plan)) continue
      const { occupant, local } = plan
      const blocked =
        claimed.has(plan.remote.path) ||
        (occupant !== null && !vacated.has(occupant.path) && !(isDraftOnly(occupant) && !local?.draft))
      if (blocked) {
        failed.add(plan)
        settled = false
      } else {
        claimed.add(plan.remote.path)
      }
    }
  }

  for (const plan of plans) if (failed.has(plan)) hold(plan.remote.version)
  const placing = plans.filter((plan) => !failed.has(plan))
  for (const { local } of placing) if (local) await tx.deleteFile(projectId, local.path)
  for (const { remote, local } of placing) {
    const occupant = await tx.getFile(projectId, remote.path)
    // Only an unsaved draft can be here now; keep it on top of the server's file.
    const draft = occupant?.draft ?? local?.draft ?? null
    await tx.putFile({
      partition,
      projectId,
      localId: local?.localId ?? occupant?.localId ?? crypto.randomUUID(),
      path: remote.path,
      base: { id: remote.id, path: remote.path, version: remote.version, content: remote.content },
      content: remote.content,
      batch: null,
      draft: draft?.content === remote.content ? null : draft,
      conflict: null,
    })
  }
  return reached
}

/** Follow the server's explicit folders, except where this device has a folder change still to send. */
async function applyRemoteFolders(tx: StorageTransaction, partition: string, projectId: string, remote: string[]) {
  const server = new Set(remote)
  const local = await tx.listFolders(projectId)
  for (const folder of local) {
    const onServer = server.has(folder.path)
    const next = folder.base === folder.local ? { ...folder, base: onServer, local: onServer } : { ...folder, base: onServer }
    if (!next.base && !next.local) await tx.deleteFolder(projectId, folder.path)
    else await tx.putFolder(next)
  }
  const known = new Set(local.map((folder) => folder.path))
  for (const path of server) if (!known.has(path)) await tx.putFolder({ partition, projectId, path, base: true, local: true, batch: null })
}

/** Drop this device's changes to a conflicted file and take the server's copy (or its absence). */
async function takeTheirs(tx: StorageTransaction, projectId: string, file: LocalFile, current: { id: string; version: number; content: string } | null) {
  await tx.deleteFile(projectId, file.path)
  if (current === null) return
  const serverPath = file.base?.path ?? file.path
  const occupant = await tx.getFile(projectId, serverPath)
  if (occupant) throw new Error(`${serverPath} is used by another file on this device. Move that file first.`)
  await tx.putFile({
    ...file,
    path: serverPath,
    base: { id: current.id, path: serverPath, version: current.version, content: current.content },
    content: current.content,
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

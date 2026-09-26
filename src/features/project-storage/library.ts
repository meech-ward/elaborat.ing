import type { ProjectDatabase } from "./database"
import { isDirty, type LocalProject } from "./model"
import { RemoteError, type ProjectRemote, type RemoteProject } from "./remote"
import { ProjectSync, type SyncOutcome } from "./sync"

/**
 * One account's projects, on this device and on the server, for the project
 * list and project pages. It wraps `ProjectSync`, remembers the server's list
 * from the last refresh, and says what state each project is in. No React.
 */

export type ProjectStatus =
  /** On the server, not yet downloaded to this device. */
  | "not-downloaded"
  /** On this device and the server, nothing waiting to send. */
  | "synced"
  /** Changes saved on this device that the server does not have yet. */
  | "unsynced"
  /** A save conflicts with the server's copy and needs a decision. */
  | "conflict"
  /** Sync stopped; see `stopped`. */
  | "stopped"

export type ProjectEntry = {
  id: string
  title: string
  role: LocalProject["role"]
  status: ProjectStatus
  stopped: LocalProject["syncError"]
  archived: boolean
}

export type LibraryState = {
  entries: ProjectEntry[]
  /** The server could not be reached on the last refresh. */
  offline: boolean
  loaded: boolean
}

/** A remote for a device with no connection to the server: every call is "offline". */
export const offlineRemote: ProjectRemote = new Proxy({} as ProjectRemote, {
  get: () => async () => {
    throw new RemoteError("network", "Offline")
  },
})

export class ProjectLibrary {
  readonly sync: ProjectSync
  private state: LibraryState = { entries: [], offline: false, loaded: false }
  private catalog: RemoteProject[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly db: ProjectDatabase,
    remote: ProjectRemote,
    readonly partition: string,
  ) {
    this.sync = new ProjectSync(db, remote, partition)
    this.sync.subscribe(() => void this.load())
  }

  getState(): LibraryState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(next: Partial<LibraryState>) {
    this.state = { ...this.state, ...next }
    for (const listener of [...this.listeners]) listener()
  }

  /** Re-read the projects on this device. */
  async load(): Promise<void> {
    const local = await this.db.listProjects(this.partition)
    const entries: ProjectEntry[] = []
    for (const project of local) {
      const files = await this.db.transaction(this.partition, "readonly", (tx) => tx.listFiles(project.id))
      const conflict = files.some((file) => file.conflict !== null)
      const unsynced = !project.created || project.pending !== null || project.pendingTitle !== null || files.some(isDirty)
      entries.push({
        id: project.id,
        title: project.pendingTitle ?? project.title,
        role: project.role,
        status: project.syncError ? "stopped" : conflict ? "conflict" : unsynced ? "unsynced" : "synced",
        stopped: project.syncError,
        archived: project.archivedAt !== null,
      })
    }
    const known = new Set(entries.map((entry) => entry.id))
    for (const remote of this.catalog) {
      if (known.has(remote.id)) continue
      entries.push({ id: remote.id, title: remote.title, role: remote.role, status: "not-downloaded", stopped: null, archived: remote.archived_at !== null })
    }
    entries.sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1))
    this.set({ entries, loaded: true })
  }

  /** Ask the server for the account's projects and pull changes into those on this device. */
  async refresh(): Promise<void> {
    try {
      this.catalog = await this.sync.refresh()
      this.set({ offline: false })
    } catch (error) {
      if (!(error instanceof RemoteError) || error.kind !== "network") throw error
      this.set({ offline: true })
    }
    await this.load()
  }

  /** Send every project with changes waiting on this device (after the connection returns, for example). */
  async syncWaiting(): Promise<void> {
    for (const entry of this.state.entries) {
      if (entry.status !== "unsynced") continue
      const outcome = await this.syncProject(entry.id)
      if (outcome.status === "offline") return
    }
  }

  /** A new project on this device; it reaches the server on the next sync. */
  async create(title: string): Promise<string> {
    const project = await this.sync.createProject(title.trim() || "Untitled project")
    await this.load()
    return project.id
  }

  /**
   * Make sure a project is on this device, downloading it if the server has
   * it. Returns false when neither has it.
   */
  async open(projectId: string): Promise<boolean> {
    if ((await this.db.listProjects(this.partition)).some((project) => project.id === projectId)) return true
    let entry = this.catalog.find((candidate) => candidate.id === projectId)
    if (!entry) {
      await this.refresh()
      entry = this.catalog.find((candidate) => candidate.id === projectId)
    }
    if (!entry) return false
    await this.sync.download(entry)
    await this.load()
    return true
  }

  /** Send and receive one project's changes. */
  async syncProject(projectId: string): Promise<SyncOutcome> {
    const outcome = await this.sync.sync(projectId)
    this.set({ offline: outcome.status === "offline" })
    await this.load()
    return outcome
  }
}

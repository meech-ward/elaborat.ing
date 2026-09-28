import { personName } from "@/features/auth/accountName"
import type { ProjectDatabase } from "./database"
import { isDirty, type LocalFile, type LocalProject, type Role } from "./model"
import { RemoteError, type MemberRole, type ProjectRemote, type RemoteInvitation, type RemoteProject } from "./remote"
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

/** A project someone shared with this account, waiting for it to accept. */
export type Invitation = { projectId: string; title: string; role: RemoteInvitation["role"] }

/** Someone with access to a project, or invited to it. */
export type Member = {
  userId: string
  /** Null for an account without an email address. */
  email: string | null
  /** The name they set or their sign-in provider gave, else their email; null when neither. */
  name: string | null
  role: Role
  /** Invited and not yet accepted. Only the owner is shown these. */
  invited: boolean
}

export type LibraryState = {
  entries: ProjectEntry[]
  /** Invitations waiting for this account, as the server last listed them. */
  invitations: Invitation[]
  /** The server could not be reached on the last refresh. */
  offline: boolean
  loaded: boolean
}

/** Files with changes the server does not have: saved but not synced, unsaved edits, or a conflict. */
const waiting = (files: LocalFile[]) => files.filter((file) => isDirty(file) || file.draft !== null || file.conflict !== null)

/** A remote for a device with no connection to the server: every call is "offline". */
export const offlineRemote: ProjectRemote = new Proxy({} as ProjectRemote, {
  get: () => async () => {
    throw new RemoteError("network", "Offline")
  },
})

export class ProjectLibrary {
  readonly sync: ProjectSync
  private state: LibraryState = { entries: [], invitations: [], offline: false, loaded: false }
  private catalog: RemoteProject[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly db: ProjectDatabase,
    private readonly remote: ProjectRemote,
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

  /** Ask the server for the invitations waiting for this account. Offline, the last ones stay. */
  async refreshInvitations(): Promise<void> {
    try {
      const listed = await this.remote.listInvitations()
      this.set({ invitations: listed.map((entry) => ({ projectId: entry.project_id, title: entry.title, role: entry.role })), offline: false })
    } catch (error) {
      if (!(error instanceof RemoteError) || error.kind !== "network") throw error
      this.set({ offline: true })
    }
  }

  /** Accept an invitation: the project joins the list and is downloaded to this device. */
  async accept(projectId: string): Promise<void> {
    const project = await this.remote.acceptInvitation(projectId)
    this.catalog = [...this.catalog.filter((entry) => entry.id !== project.id), project]
    this.set({ invitations: this.state.invitations.filter((entry) => entry.projectId !== project.id) })
    await this.sync.download(project)
    await this.load()
  }

  /**
   * Why leaving a project now would lose work on this device, or null: files
   * with changes the server does not have (saved but not synced, unsaved
   * edits, or a conflict), named, or a new title still to send.
   */
  async leaveProblem(projectId: string): Promise<string | null> {
    const [project, files] = await this.db.transaction(this.partition, "readonly", async (tx) => [await tx.getProject(projectId), await tx.listFiles(projectId)] as const)
    if (!project) return null
    const paths = waiting(files).map((file) => file.path)
    if (paths.length === 0 && project.pendingTitle === null) return null
    const title = project.pendingTitle ?? project.title
    const what = paths.length > 0 ? paths.join(", ") : "its new title"
    return `Not left: ${title} has changes on this device that have not synced (${what}). Sync them first, so nothing is lost.`
  }

  /**
   * Leave a project shared with this account: the server removes the
   * membership, then the project and its files leave this device. Refused
   * while this device holds changes to it that have not synced.
   */
  async leave(projectId: string): Promise<void> {
    const problem = await this.leaveProblem(projectId)
    if (problem) throw new Error(problem)
    try {
      await this.remote.leaveProject(projectId)
    } catch (error) {
      if (error instanceof RemoteError && error.kind === "network") throw new Error("Leaving a project needs a connection. Try again when you are online.")
      throw error
    }
    this.catalog = this.catalog.filter((entry) => entry.id !== projectId)
    await this.sync.forget(projectId)
    await this.load()
  }

  /**
   * Who a project is shared with: its owner first, then members, then, for
   * the owner, invitations not yet accepted. Needs a connection.
   */
  async members(projectId: string): Promise<Member[]> {
    const local = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(projectId))
    if (local?.created === false && !this.catalog.some((entry) => entry.id === projectId)) {
      throw new Error("This project is only on this device so far, so it is not shared with anyone.")
    }
    try {
      const listed = await this.remote.listMembers(projectId)
      return listed.map((entry) => ({
        userId: entry.user_id,
        email: entry.email,
        name: personName(entry.name, entry.email),
        role: entry.role,
        invited: entry.role !== "owner" && entry.accepted_at === null,
      }))
    } catch (error) {
      if (error instanceof RemoteError && error.kind === "network") throw new Error("Seeing who a project is shared with needs a connection. Try again when you are online.")
      throw error
    }
  }

  /**
   * Who last changed each of these files, by path, as the server knows it:
   * their user id and name (or email). Files it does not know, and people no
   * longer in the project, are left out. Needs a connection.
   */
  async fileEditors(projectId: string, paths: readonly string[]): Promise<Map<string, { userId: string; name: string }>> {
    const [editors, members] = await Promise.all([this.remote.fileEditors(projectId, [...paths]), this.remote.listMembers(projectId)])
    const names = new Map(members.map((member) => [member.user_id, personName(member.name, member.email)]))
    const found = new Map<string, { userId: string; name: string }>()
    for (const { path, updated_by } of editors) {
      const name = updated_by ? names.get(updated_by) : null
      if (updated_by && name && paths.includes(path)) found.set(path, { userId: updated_by, name })
    }
    return found
  }

  /** Change a member's role, or remove a member or an invitation (role null). Owner only; needs a connection. */
  async share(projectId: string, userId: string, role: MemberRole | null): Promise<void> {
    try {
      await this.remote.shareProject(projectId, userId, role)
    } catch (error) {
      if (error instanceof RemoteError && error.kind === "network") throw new Error("Changing who a project is shared with needs a connection. Try again when you are online.")
      throw error
    }
  }

  /**
   * Invite someone by email. An account gets the usual invitation; an email
   * without one gets an email to join. Owner only; needs a connection.
   */
  async invite(projectId: string, email: string, role: MemberRole): Promise<void> {
    try {
      await this.remote.inviteByEmail(projectId, email, role)
    } catch (error) {
      if (error instanceof RemoteError && error.kind === "network") throw new Error("Inviting someone needs a connection. Try again when you are online.")
      throw error
    }
  }

  /** Archive a project: it stays readable, and refuses changes until it is unarchived. */
  async archive(projectId: string): Promise<void> {
    await this.setArchived(projectId, true)
  }

  /** Unarchive a project, so it takes changes again. */
  async unarchive(projectId: string): Promise<void> {
    await this.setArchived(projectId, false)
  }

  private async setArchived(projectId: string, archived: boolean): Promise<void> {
    let project: RemoteProject
    try {
      project = archived ? await this.remote.archiveProject(projectId) : await this.remote.unarchiveProject(projectId)
    } catch (error) {
      if (error instanceof RemoteError && error.kind === "network") {
        throw new Error(`${archived ? "Archiving" : "Unarchiving"} a project needs a connection. Try again when you are online.`)
      }
      throw error
    }
    this.catalog = [...this.catalog.filter((entry) => entry.id !== project.id), project]
    await this.sync.adopt(project)
    await this.load()
  }

  /** How many of the project's files on this device have changes the server does not have. */
  async unsyncedFiles(projectId: string): Promise<number> {
    return waiting(await this.db.transaction(this.partition, "readonly", (tx) => tx.listFiles(projectId))).length
  }

  /**
   * Permanently delete a project this account owns: from the server, then
   * from this device, changes not yet synced included. The server refuses
   * anyone but the owner, and agents. A project that never reached the
   * server is only removed from this device.
   */
  async deletePermanently(projectId: string): Promise<void> {
    const local = await this.db.transaction(this.partition, "readonly", (tx) => tx.getProject(projectId))
    if (local?.created !== false || this.catalog.some((entry) => entry.id === projectId)) {
      try {
        await this.remote.deleteProject(projectId)
      } catch (error) {
        if (error instanceof RemoteError && error.kind === "network") throw new Error("Deleting a project needs a connection. Try again when you are online.")
        throw error
      }
    }
    this.catalog = this.catalog.filter((entry) => entry.id !== projectId)
    await this.sync.forget(projectId)
    await this.load()
  }

  /** Send and receive one project's changes. */
  async syncProject(projectId: string): Promise<SyncOutcome> {
    const outcome = await this.sync.sync(projectId)
    this.set({ offline: outcome.status === "offline" })
    await this.load()
    return outcome
  }
}

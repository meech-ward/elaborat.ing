import { isValidProjectPath, MAX_ENTRIES, MAX_PROJECT_BYTES, byteLength, type Role, type SaveChange } from "./model"
import { RemoteError, RemoteProject, SaveResult, type DeletedFile, type ProjectRemote, type RemoteFile, type RemoteInvitation } from "./remote"

/**
 * An in-memory stand-in for the project service, for tests. It follows the
 * rules of `supabase/schemas/save_files.sql` and the project functions:
 * versions, conflicts, path collisions, limits and stored results by
 * mutation id. Each `remote(userId)` acts as one signed-in person.
 */

type ServerFile = RemoteFile
type ServerProject = {
  id: string
  owner: string
  title: string
  revision: number
  archivedAt: string | null
  files: Map<string, ServerFile>
  history: Array<{ fileId: string; version: number; deleted: boolean }>
  folders: Set<string>
  savedResults: Map<string, { user: string; payload: string; result: SaveResult }>
  /** Everyone the owner shared the project with. An invitation grants nothing until its person accepts it. */
  members: Map<string, { role: InvitedRole; accepted: boolean; invitedAt: string }>
}

type InvitedRole = RemoteInvitation["role"]

const ancestors = (path: string) => {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

export class FakeProjectServer {
  readonly projects = new Map<string, ServerProject>()
  /** Every call made, for asserting what sync sent. */
  readonly calls: Array<{ user: string; method: string; args: unknown[] }> = []
  offline = false
  /** Apply the next N calls but lose their responses, as a dropped connection would. */
  loseResponses = 0
  maxFiles = MAX_ENTRIES
  /** Orders invitations, newest last, as their times would. */
  private invitations = 0

  remote(user: string): ProjectRemote {
    const call = async <T>(method: string, args: unknown[], work: () => T): Promise<T> => {
      this.calls.push({ user, method, args: structuredClone(args) })
      if (this.offline) throw new RemoteError("network", "Failed to fetch")
      const result = work()
      if (this.loseResponses > 0) {
        this.loseResponses--
        throw new RemoteError("network", "The connection was lost")
      }
      return structuredClone(result)
    }
    return {
      listProjects: () => call("listProjects", [], () => this.list(user)),
      createProject: (id, title) => call("createProject", [id, title], () => this.create(user, id, title)),
      renameProject: (id, title) => call("renameProject", [id, title], () => this.rename(user, id, title)),
      saveFiles: (projectId, mutationId, changes) =>
        call("saveFiles", [projectId, mutationId, changes], () => SaveResult.parse(this.save(user, projectId, mutationId, changes))),
      changedFiles: (projectId, since, until) =>
        call("changedFiles", [projectId, since, until], () =>
          [...this.readable(user, projectId).files.values()]
            .filter((file) => file.version > since && file.version <= until)
            .sort((a, b) => a.version - b.version || (a.id < b.id ? -1 : 1)),
        ),
      deletedFiles: (projectId, since, until) =>
        call("deletedFiles", [projectId, since, until], () =>
          this.readable(user, projectId)
            .history.filter((entry) => entry.deleted && entry.version > since && entry.version <= until)
            .map((entry): DeletedFile => ({ id: entry.fileId, version: entry.version })),
        ),
      folders: (projectId) => call("folders", [projectId], () => [...this.readable(user, projectId).folders].sort()),
      listInvitations: () => call("listInvitations", [], () => this.pendingFor(user)),
      acceptInvitation: (projectId) => call("acceptInvitation", [projectId], () => this.accept(user, projectId)),
      leaveProject: (projectId) => call("leaveProject", [projectId], () => this.leave(user, projectId)),
    }
  }

  role(user: string, project: ServerProject): Role | null {
    if (project.owner === user) return "owner"
    const member = project.members.get(user)
    return member?.accepted ? member.role : null
  }

  /** Make `user` a member, as if they had accepted an invitation. */
  share(projectId: string, user: string, role: InvitedRole) {
    this.invite(projectId, user, role)
    this.projects.get(projectId)!.members.get(user)!.accepted = true
  }

  /** Invite `user`, as `share_project` does: they see nothing of the project until they accept. */
  invite(projectId: string, user: string, role: InvitedRole) {
    const project = this.projects.get(projectId)!
    const invitedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, ++this.invitations)).toISOString()
    project.members.set(user, { role, accepted: false, invitedAt })
    project.revision++
  }

  private pendingFor(user: string): RemoteInvitation[] {
    return [...this.projects.values()]
      .flatMap((project) => {
        const member = project.members.get(user)
        return member && !member.accepted ? [{ project_id: project.id, title: project.title, role: member.role, invited_at: member.invitedAt }] : []
      })
      .sort((a, b) => (a.invited_at < b.invited_at ? 1 : -1))
  }

  /** Only the invited person can accept, and only their own invitation (42501 otherwise). */
  private accept(user: string, projectId: string): RemoteProject {
    const project = this.projects.get(projectId)
    const member = project?.members.get(user)
    if (!project || !member) throw new RemoteError("access", "No invitation for this project")
    if (!member.accepted) {
      member.accepted = true
      project.revision++
    }
    return this.summary(project, user)
  }

  /** A member leaves, or declines an invitation. The owner is not a member, so cannot leave (42501, as for anyone else). */
  private leave(user: string, projectId: string): void {
    const project = this.projects.get(projectId)
    if (!project || !project.members.delete(user)) throw new RemoteError("access", "You are not a member of this project")
    project.revision++
  }

  private summary(project: ServerProject, user: string): RemoteProject {
    return RemoteProject.parse({
      id: project.id,
      title: project.title,
      revision: project.revision,
      archived_at: project.archivedAt,
      updated_at: new Date(0).toISOString(),
      role: this.role(user, project),
    })
  }

  private list(user: string) {
    return [...this.projects.values()].filter((project) => this.role(user, project)).map((project) => this.summary(project, user))
  }

  private readable(user: string, projectId: string): ServerProject {
    const project = this.projects.get(projectId)
    if (!project || !this.role(user, project)) throw new RemoteError("access", "Project not found or access denied")
    return project
  }

  private editable(user: string, projectId: string): ServerProject {
    const project = this.readable(user, projectId)
    const role = this.role(user, project)
    if (role !== "owner" && role !== "editor") throw new RemoteError("access", "Editor access required")
    return project
  }

  private create(user: string, id: string, title: string) {
    let project = this.projects.get(id)
    if (!project) {
      project = {
        id,
        owner: user,
        title,
        revision: 0,
        archivedAt: null,
        files: new Map(),
        history: [],
        folders: new Set(),
        savedResults: new Map(),
        members: new Map(),
      }
      this.projects.set(id, project)
    }
    if (project.owner !== user) throw new RemoteError("unavailable", "Project unavailable")
    return this.summary(project, user)
  }

  private rename(user: string, id: string, title: string) {
    const project = this.editable(user, id)
    if (project.archivedAt) throw new RemoteError("archived", "Project is archived")
    project.title = title
    project.revision++
    return this.summary(project, user)
  }

  private save(user: string, projectId: string, mutationId: string, changes: SaveChange[]): SaveResult {
    const project = this.editable(user, projectId)
    const payload = JSON.stringify(changes)
    const earlier = project.savedResults.get(mutationId)
    if (earlier) {
      if (earlier.user !== user || earlier.payload !== payload) throw new RemoteError("invalid", "This mutation id was already used for a different save")
      return earlier.result
    }
    if (project.archivedAt) throw new RemoteError("archived", "Project is archived")
    if (changes.length < 1 || changes.length > 4096) throw new RemoteError("invalid", "Changes must be a list of 1 to 4096 items")

    const touched = new Set<string>()
    const conflicts: Array<{ path: string; base_version: number | null; current: { id: string; version: number; content: string } | null }> = []
    const currentOf = (file: ServerFile | undefined) => (file ? { id: file.id, version: file.version, content: file.content } : null)
    for (const change of changes) {
      if (!isValidProjectPath(change.path)) throw new RemoteError("invalid", `Invalid path: ${change.path}`)
      if (touched.has(change.path)) throw new RemoteError("invalid", `A save can change each path only once: ${change.path}`)
      touched.add(change.path)
      if (change.op === "put" || change.op === "delete" || change.op === "move") {
        const base = "base_version" in change ? (change.base_version ?? null) : null
        const file = project.files.get(change.path)
        if ((base === null && file) || (base !== null && file?.version !== base)) {
          conflicts.push({ path: change.path, base_version: base, current: currentOf(file) })
        }
      }
      if (change.op === "move") {
        if (!isValidProjectPath(change.to)) throw new RemoteError("invalid", `Invalid path: ${change.to}`)
        if (touched.has(change.to)) throw new RemoteError("invalid", `A save can change each path only once: ${change.to}`)
        touched.add(change.to)
        const occupant = project.files.get(change.to)
        if (occupant) conflicts.push({ path: change.to, base_version: null, current: currentOf(occupant) })
      }
    }
    if (conflicts.length > 0) return { status: "conflict", project: { id: project.id, revision: project.revision }, conflicts }

    // Apply to copies, so a refusal below leaves nothing behind.
    const files = new Map(project.files)
    const folders = new Set(project.folders)
    const history: ServerProject["history"] = []
    const revision = project.revision + 1
    const addedPaths: string[] = []
    const addedFiles: string[] = []
    const applied: Array<{ op: SaveChange["op"]; path: string; to?: string; id?: string; version?: number }> = []
    for (const change of changes) {
      if (change.op === "put") {
        const existing = files.get(change.path)
        const file = { id: existing?.id ?? crypto.randomUUID(), path: change.path, content: change.content, version: revision }
        files.set(change.path, file)
        if (!existing) {
          addedPaths.push(change.path)
          addedFiles.push(change.path)
        }
        history.push({ fileId: file.id, version: revision, deleted: false })
        applied.push({ op: "put", path: change.path, id: file.id, version: revision })
      } else if (change.op === "delete") {
        const file = files.get(change.path)!
        files.delete(change.path)
        history.push({ fileId: file.id, version: revision, deleted: true })
        applied.push({ op: "delete", path: change.path, id: file.id, version: revision })
      } else if (change.op === "move") {
        const file = files.get(change.path)!
        files.delete(change.path)
        const moved = { ...file, path: change.to, content: change.content ?? file.content, version: revision }
        files.set(change.to, moved)
        addedPaths.push(change.to)
        addedFiles.push(change.to)
        history.push({ fileId: file.id, version: revision, deleted: false })
        applied.push({ op: "move", path: change.path, to: change.to, id: file.id, version: revision })
      } else if (change.op === "mkdir") {
        folders.add(change.path)
        addedPaths.push(change.path)
        applied.push({ op: "mkdir", path: change.path })
      } else {
        folders.delete(change.path)
        applied.push({ op: "rmdir", path: change.path })
      }
    }
    const collision =
      addedPaths.find((path) => ancestors(path).some((ancestor) => files.has(ancestor)) || (files.has(path) && folders.has(path))) ??
      addedFiles.find((path) => [...files.keys(), ...folders].some((other) => other.startsWith(`${path}/`)))
    if (collision) throw new RemoteError("path-taken", `Path is already used by a file or folder: ${collision}`, collision)
    if (files.size > this.maxFiles || folders.size > 4096) throw new RemoteError("limit", "A project can hold at most 4096 files and 4096 folders")
    if ([...files.values()].reduce((sum, file) => sum + byteLength(file.content), 0) > MAX_PROJECT_BYTES) {
      throw new RemoteError("limit", "A project can hold at most 64 MiB of files")
    }

    project.files = files
    project.folders = folders
    project.history.push(...history)
    project.revision = revision
    const result: SaveResult = { status: "saved", project: { id: project.id, revision }, changes: applied }
    project.savedResults.set(mutationId, { user, payload, result })
    return result
  }

  /** A file's content on the server, or undefined. */
  content(projectId: string, path: string): string | undefined {
    return this.projects.get(projectId)?.files.get(path)?.content
  }

  paths(projectId: string): string[] {
    return [...(this.projects.get(projectId)?.files.keys() ?? [])].sort()
  }

  saves(): number {
    return this.calls.filter((entry) => entry.method === "saveFiles").length
  }
}

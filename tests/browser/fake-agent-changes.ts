import type { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { RemoteError } from "../../src/features/project-storage/remote.ts"

/**
 * The agent changes functions of `supabase/schemas/agent_changes.sql`, in
 * memory, over the fake project server's projects: the versions an agent
 * saved (recorded by `save`, which saves through the server as the agent
 * would), and each person's seen marker.
 */

type Change = {
  projectId: string
  file_id: string
  version: number
  path: string
  deleted: boolean
  content: string | null
  created_at: string
  author: string
  agent: string | null
  previous: { version: number; path: string; deleted: boolean; content: string | null } | null
  thread: { id: string; comment_id: string; opening: string | null } | null
}

type Args = Record<string, unknown>

export class FakeAgentChanges {
  readonly changes: Change[] = []
  /** Each person's marker, by `${projectId}:${user}`. */
  readonly seen = new Map<string, number>()

  constructor(private readonly server: FakeProjectServer) {}

  static handles(rpc: string): boolean {
    return ["list_agent_changes", "count_agent_changes", "mark_agent_changes_seen"].includes(rpc)
  }

  /** Put `content` at `path` as `user`'s agent (named `agent`): a new version on the server, recorded as an agent change. */
  async save(user: string, projectId: string, path: string, content: string, { agent = "Claude" }: { agent?: string | null } = {}) {
    const project = this.server.projects.get(projectId)!
    const before = project.files.get(path)
    const result = await this.server
      .remote(user)
      .saveFiles(projectId, crypto.randomUUID(), [{ op: "put", path, content, ...(before ? { base_version: before.version } : {}) }])
    if (result.status !== "saved") throw new Error(`The agent's save of ${path} was refused`)
    const file = project.files.get(path)!
    this.changes.push({
      projectId,
      file_id: file.id,
      version: file.version,
      path,
      deleted: false,
      content,
      created_at: new Date().toISOString(),
      author: user,
      agent,
      previous: before ? { version: before.version, path: before.path, deleted: false, content: before.content } : null,
      thread: null,
    })
    return file
  }

  call(user: string, rpc: string, args: Args): unknown {
    if (this.server.offline) throw new RemoteError("network", "Failed to fetch")
    const projectId = String(args.project_id)
    const project = this.server.projects.get(projectId)
    if (!project || !this.server.role(user, project)) throw new RemoteError("access", "Project unavailable")
    const seen = this.seen.get(`${projectId}:${user}`) ?? 0
    const mine = this.changes.filter((change) => change.projectId === projectId).sort((a, b) => b.version - a.version || a.path.localeCompare(b.path))
    switch (rpc) {
      case "count_agent_changes":
        return Math.min(100, mine.filter((change) => change.version > seen).length)
      case "mark_agent_changes_seen": {
        const marked = Math.max(seen, Math.min(Number(args.version), project.revision))
        this.seen.set(`${projectId}:${user}`, marked)
        return { project_id: projectId, seen: marked }
      }
      case "list_agent_changes": {
        const before = typeof args.before === "number" ? args.before : null
        const size = Math.min(Math.max(typeof args.max_count === "number" ? args.max_count : 20, 1), 50)
        const versions = [...new Set(mine.filter((change) => before === null || change.version < before).map((change) => change.version))]
        const page = new Set(versions.slice(0, size))
        const current = new Map([...project.files.values()].map((file) => [file.id, file.version]))
        return {
          project_id: projectId,
          revision: project.revision,
          seen,
          more: versions.length > size,
          changes: mine
            .filter((change) => page.has(change.version))
            .map(({ file_id, version, path, deleted, content, created_at, author, agent, previous, thread }) => ({
              file_id, version, path, deleted, content, created_at, agent, previous, thread,
              author: { user_id: author, email: this.server.emails.get(author) ?? null, name: this.server.nameOf(author) },
              latest: current.get(file_id) === version,
            })),
        }
      }
    }
    throw new Error(`No fake for ${rpc}`)
  }
}

import type { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { RemoteError } from "../../src/features/project-storage/remote.ts"

type Category = {
  id: string
  owner: string
  name: string
  archived_at: string | null
  updated_at: string
  revision: number
  projects: Set<string>
}

/** Personal organization over the browser fixture's existing project access. */
export class FakeProjectCategories {
  readonly categories = new Map<string, Category>()
  private ticks = 0

  constructor(private readonly server: FakeProjectServer) {}

  static handles(rpc: string) {
    return ["list_project_categories", "create_project_category", "rename_project_category", "set_project_category_archived", "set_project_category_membership", "set_project_categories"].includes(rpc)
  }

  private tick() {
    return new Date(Date.UTC(2026, 10, 2, 12, 0, ++this.ticks)).toISOString()
  }

  private readable(user: string, id: string) {
    const project = this.server.projects.get(id)
    return project !== undefined && this.server.role(user, project) !== null
  }

  private own(user: string, id: string) {
    const category = this.categories.get(id)
    if (!category || category.owner !== user) throw new RemoteError("access", "Category unavailable")
    return category
  }

  private row(user: string, category: Category) {
    return {
      id: category.id, name: category.name, archived_at: category.archived_at,
      updated_at: category.updated_at, revision: category.revision,
      project_ids: [...category.projects].filter(id => this.readable(user, id)).sort(),
    }
  }

  private list(user: string) {
    return [...this.categories.values()].filter(category => category.owner === user)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map(category => this.row(user, category))
  }

  private changed(category: Category) {
    category.revision++
    category.updated_at = this.tick()
  }

  private name(value: unknown) {
    const name = String(value ?? "").trim().normalize("NFC")
    if (!name || [...name].length > 160 || /[\u0000-\u001f\u007f]/.test(name)) throw new RemoteError("invalid", "Category names must contain 1 to 160 characters without control characters.")
    return name
  }

  private unique(user: string, id: string, name: string) {
    if ([...this.categories.values()].some(category => category.owner === user && category.id !== id && category.archived_at === null && category.name.toLowerCase() === name.toLowerCase())) {
      throw new RemoteError("invalid", "A category with that name already exists. Choose a different name.")
    }
  }

  call(user: string, rpc: string, args: Record<string, unknown> = {}): unknown {
    if (this.server.offline) throw new RemoteError("network", "Failed to fetch")
    if (this.server.limited) throw new RemoteError("account-limit", this.server.limited)
    if (rpc === "list_project_categories") return this.list(user)
    if (rpc === "set_project_categories") {
      const projectId = String(args.project_id)
      if (!this.readable(user, projectId)) throw new RemoteError("access", "Project unavailable")
      const ids = args.category_ids
      if (!Array.isArray(ids) || ids.length > 128 || ids.some(id => typeof id !== "string")) throw new RemoteError("invalid", "Invalid categories")
      const wanted = new Set(ids as string[])
      for (const id of wanted) if (this.own(user, id).archived_at !== null) throw new RemoteError("archived", "Category is archived")
      for (const category of this.categories.values()) {
        if (category.owner !== user || category.archived_at !== null) continue
        if (category.projects.has(projectId) === wanted.has(category.id)) continue
        if (wanted.has(category.id)) category.projects.add(projectId)
        else category.projects.delete(projectId)
        this.changed(category)
      }
      return this.list(user)
    }
    const id = String(args.category_id)
    if (rpc === "create_project_category") {
      const name = this.name(args.name)
      const previous = this.categories.get(id)
      if (previous) return this.row(user, this.own(user, id))
      this.unique(user, id, name)
      const category: Category = { id, owner: user, name, archived_at: null, updated_at: this.tick(), revision: 0, projects: new Set() }
      this.categories.set(id, category)
      return this.row(user, category)
    }
    const category = this.own(user, id)
    if (rpc === "rename_project_category") {
      const name = this.name(args.name)
      if (category.archived_at === null) this.unique(user, id, name)
      if (category.name !== name) { category.name = name; this.changed(category) }
    } else if (rpc === "set_project_category_archived") {
      if ((category.archived_at !== null) !== (args.archived === true)) {
        if (args.archived !== true) this.unique(user, id, category.name)
        category.archived_at = args.archived === true ? this.tick() : null
        this.changed(category)
      }
    } else if (rpc === "set_project_category_membership") {
      const projectId = String(args.project_id)
      if (!this.readable(user, projectId)) throw new RemoteError("access", "Project unavailable")
      if (category.archived_at !== null) throw new RemoteError("archived", "Category is archived")
      const included = args.included === true
      if (category.projects.has(projectId) !== included) {
        if (included) category.projects.add(projectId)
        else category.projects.delete(projectId)
        this.changed(category)
      }
    } else throw new Error(`No category fixture for ${rpc}`)
    return this.row(user, category)
  }
}

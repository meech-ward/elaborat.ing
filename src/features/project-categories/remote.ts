import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod/mini"
import { classify, RemoteError } from "@/features/project-storage/remote"
import { categoryName, ProjectCategories, ProjectCategory } from "./model"

export interface ProjectCategoryRemote {
  list(): Promise<ProjectCategory[]>
  create(id: string, name: string): Promise<ProjectCategory>
  rename(id: string, name: string): Promise<ProjectCategory>
  setArchived(id: string, archived: boolean): Promise<ProjectCategory>
  setMembership(categoryId: string, projectId: string, included: boolean): Promise<ProjectCategory>
  setProjectCategories(projectId: string, categoryIds: string[]): Promise<ProjectCategory[]>
}

const ACCOUNT_CHANGED = "The signed-in account changed. Open your projects again before organizing them."

/** Calls the ordinary database functions as one specific account, even across an account switch. */
export class SupabaseProjectCategoryRemote implements ProjectCategoryRemote {
  constructor(private readonly client: Pick<SupabaseClient, "auth" | "rpc">, private readonly userId: string) {}

  private async rpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
    try {
      const { data: { session }, error } = await this.client.auth.getSession()
      if (error) throw new RemoteError(!error.status || error.status >= 500 ? "network" : "access", "Could not check the signed-in account. Try again.")
      if (!session || session.user.id !== this.userId) throw new RemoteError("access", ACCOUNT_CHANGED)
      // The shared client's current session can change while a request waits.
      // Pin this single request to the session checked above; the server still
      // authorizes it through its normal JWT and row-level security rules.
      const result = await this.client.rpc(name, args).setHeader("Authorization", `Bearer ${session.access_token}`)
      if (result.error) throw classify(result.error)
      return result.data
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError("network", "Could not reach your categories. Check your connection and try again.")
    }
  }

  private row(value: unknown, expectedId: string): ProjectCategory {
    const result = ProjectCategory.safeParse(value)
    if (!result.success || result.data.id !== expectedId) throw new RemoteError("invalid", "The category service returned data this app cannot use.")
    return result.data
  }

  private rows(value: unknown): ProjectCategory[] {
    const result = ProjectCategories.safeParse(value)
    if (!result.success || new Set(result.data.map(category => category.id)).size !== result.data.length)
      throw new RemoteError("invalid", "The category service returned data this app cannot use.")
    return result.data
  }

  async list(): Promise<ProjectCategory[]> { return this.rows(await this.rpc("list_project_categories")) }
  async create(id: string, name: string): Promise<ProjectCategory> {
    z.uuid().parse(id)
    return this.row(await this.rpc("create_project_category", { category_id: id, name: categoryName(name) }), id)
  }
  async rename(id: string, name: string): Promise<ProjectCategory> {
    z.uuid().parse(id)
    return this.row(await this.rpc("rename_project_category", { category_id: id, name: categoryName(name) }), id)
  }
  async setArchived(id: string, archived: boolean): Promise<ProjectCategory> {
    z.uuid().parse(id)
    return this.row(await this.rpc("set_project_category_archived", { category_id: id, archived }), id)
  }
  async setMembership(categoryId: string, projectId: string, included: boolean): Promise<ProjectCategory> {
    z.uuid().parse(categoryId); z.uuid().parse(projectId)
    return this.row(await this.rpc("set_project_category_membership", { category_id: categoryId, project_id: projectId, included }), categoryId)
  }
  async setProjectCategories(projectId: string, categoryIds: string[]): Promise<ProjectCategory[]> {
    z.uuid().parse(projectId)
    const ids = z.array(z.uuid()).check(z.maxLength(128)).parse([...new Set(categoryIds)])
    return this.rows(await this.rpc("set_project_categories", { project_id: projectId, category_ids: ids }))
  }
}

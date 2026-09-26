import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { ProjectPath, Role, SaveChange } from "./model"

/**
 * The project service as sync sees it: the database functions and tables
 * from `supabase/schemas`, called as the signed-in user. Every response is
 * validated before it is used.
 */

export const RemoteProject = z.object({
  id: z.uuid(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  archived_at: z.string().nullable(),
  updated_at: z.string(),
  role: Role.nullable(),
})
export type RemoteProject = z.infer<typeof RemoteProject>

/** An invitation waiting for the caller to accept, as `list_invitations` returns it. */
export const RemoteInvitation = z.object({
  project_id: z.uuid(),
  title: z.string(),
  role: z.enum(["viewer", "commenter", "editor"]),
  invited_at: z.string(),
})
export type RemoteInvitation = z.infer<typeof RemoteInvitation>

export const RemoteFile = z.object({
  id: z.uuid(),
  path: ProjectPath,
  content: z.string(),
  version: z.number().int().positive(),
})
export type RemoteFile = z.infer<typeof RemoteFile>

const SavedChange = z.object({
  op: z.enum(["put", "delete", "move", "mkdir", "rmdir"]),
  path: ProjectPath,
  to: ProjectPath.optional(),
  id: z.uuid().optional(),
  version: z.number().int().positive().optional(),
})

export const SaveResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("saved"),
    project: z.object({ id: z.uuid(), revision: z.number().int().positive() }),
    changes: z.array(SavedChange),
  }),
  z.object({
    status: z.literal("conflict"),
    project: z.object({ id: z.uuid(), revision: z.number().int().nonnegative() }),
    conflicts: z.array(z.object({
      path: ProjectPath,
      base_version: z.number().int().positive().nullable(),
      current: z.object({ id: z.uuid(), version: z.number().int().positive(), content: z.string() }).nullable(),
    })),
  }),
])
export type SaveResult = z.infer<typeof SaveResult>

/** Why a remote call failed, in the terms sync acts on. */
export type RemoteErrorKind =
  | "network" // no answer; retry later with the same request
  | "access" // not signed in, or no access to this project (42501)
  | "archived" // 55000
  | "limit" // 54000
  | "path-taken" // 23505: a path is already used by a file or folder
  | "invalid" // 22023 and other refusals of the request itself
  | "unavailable" // create_project only: the id already belongs to someone else

export class RemoteError extends Error {
  constructor(readonly kind: RemoteErrorKind, message: string, readonly detail: string | null = null) {
    super(message)
    this.name = "RemoteError"
  }
}

type PostgrestLikeError = { code?: string; message?: string; details?: string | null }

function classify(error: PostgrestLikeError): RemoteError {
  const message = error.message ?? "The project service refused the request."
  switch (error.code) {
    case "42501":
    case "PGRST301":
    case "PGRST302":
      return new RemoteError("access", message)
    case "55000":
      return new RemoteError("archived", message)
    case "54000":
      return new RemoteError("limit", message)
    case "23505":
      return new RemoteError("path-taken", message, error.details ?? null)
    case undefined:
    case "":
      return new RemoteError("network", message)
    default:
      return new RemoteError("invalid", message)
  }
}

/** Rows per request; the API returns at most 1000 (`max_rows` in config.toml). */
const PAGE = 500

export type DeletedFile = { id: string; version: number }

export interface ProjectRemote {
  listProjects(): Promise<RemoteProject[]>
  /** Creates the project, or returns it if this account already created it with this id. */
  createProject(id: string, title: string): Promise<RemoteProject>
  renameProject(id: string, title: string): Promise<RemoteProject>
  saveFiles(projectId: string, mutationId: string, changes: SaveChange[]): Promise<SaveResult>
  /** Files whose version is in (since, until]: new, changed or moved in that range. */
  changedFiles(projectId: string, since: number, until: number): Promise<RemoteFile[]>
  /** Files deleted at a version in (since, until]. */
  deletedFiles(projectId: string, since: number, until: number): Promise<DeletedFile[]>
  /** The project's explicit folders. */
  folders(projectId: string): Promise<string[]>
  /** Invitations waiting for the caller to accept, newest first. */
  listInvitations(): Promise<RemoteInvitation[]>
  /** Accept an invitation; returns the project as the caller now sees it. */
  acceptInvitation(projectId: string): Promise<RemoteProject>
  /** Leave a project shared with the caller, or decline an invitation. Owners cannot leave. */
  leaveProject(projectId: string): Promise<void>
  /** Archive a project, so it refuses changes (55000) until unarchived. Owners and editors, agents included. */
  archiveProject(projectId: string): Promise<RemoteProject>
  unarchiveProject(projectId: string): Promise<RemoteProject>
  /** Permanently delete a project and everything in it. Only its owner, and never with an agent's token. */
  deleteProject(projectId: string): Promise<void>
}

type Page = PromiseLike<{ data: unknown[] | null; error: PostgrestLikeError | null }>

export class SupabaseProjectRemote implements ProjectRemote {
  constructor(private readonly supabase: SupabaseClient) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let response
    try {
      response = await this.supabase.rpc(name, args)
    } catch (error) {
      throw new RemoteError("network", error instanceof Error ? error.message : String(error))
    }
    if (response.error) throw classify(response.error)
    return response.data
  }

  async listProjects() {
    return z.array(RemoteProject).parse(await this.rpc("list_projects", {}))
  }

  async createProject(id: string, title: string) {
    try {
      return RemoteProject.parse(await this.rpc("create_project", { project_id: id, title }))
    } catch (error) {
      // From create_project, "Project unavailable" means the id is taken.
      if (error instanceof RemoteError && error.kind === "access" && error.message === "Project unavailable") {
        throw new RemoteError("unavailable", error.message)
      }
      throw error
    }
  }

  async renameProject(id: string, title: string) {
    return RemoteProject.parse(await this.rpc("rename_project", { project_id: id, title }))
  }

  async saveFiles(projectId: string, mutationId: string, changes: SaveChange[]) {
    return SaveResult.parse(await this.rpc("save_files", { project_id: projectId, mutation_id: mutationId, changes }))
  }

  async listInvitations() {
    return z.array(RemoteInvitation).parse(await this.rpc("list_invitations", {}))
  }

  async acceptInvitation(projectId: string) {
    return RemoteProject.parse(await this.rpc("accept_invitation", { project_id: projectId }))
  }

  async leaveProject(projectId: string) {
    z.object({ project_id: z.uuid(), left: z.literal(true) }).parse(await this.rpc("leave_project", { project_id: projectId }))
  }

  async archiveProject(projectId: string) {
    return RemoteProject.parse(await this.rpc("archive_project", { project_id: projectId }))
  }

  async unarchiveProject(projectId: string) {
    return RemoteProject.parse(await this.rpc("unarchive_project", { project_id: projectId }))
  }

  async deleteProject(projectId: string) {
    z.object({ id: z.uuid(), deleted: z.literal(true) }).parse(await this.rpc("delete_project", { project_id: projectId }))
  }

  /**
   * Reads every page of a query, continuing after the last row seen rather
   * than by offset, so rows that change between pages never shift others out.
   */
  private async keyset<T>(page: (after: T | null) => Page, parse: (row: unknown) => T): Promise<T[]> {
    const rows: T[] = []
    let after: T | null = null
    for (;;) {
      let response
      try {
        response = await page(after)
      } catch (error) {
        throw new RemoteError("network", error instanceof Error ? error.message : String(error))
      }
      if (response.error) throw classify(response.error)
      const data = (response.data ?? []).map(parse)
      rows.push(...data)
      if (data.length < PAGE) return rows
      after = data[data.length - 1]
    }
  }

  changedFiles(projectId: string, since: number, until: number) {
    return this.keyset<RemoteFile>(
      (after) => {
        let query = this.supabase
          .from("project_files")
          .select("id, path, content, version")
          .eq("project_id", projectId)
          .gt("version", since)
          .lte("version", until)
        if (after) query = query.or(`version.gt.${after.version},and(version.eq.${after.version},id.gt.${after.id})`)
        return query.order("version").order("id").limit(PAGE)
      },
      (row) => RemoteFile.parse(row),
    )
  }

  deletedFiles(projectId: string, since: number, until: number) {
    return this.keyset<DeletedFile>(
      (after) => {
        let query = this.supabase
          .from("file_versions")
          .select("file_id, version")
          .eq("project_id", projectId)
          .eq("deleted", true)
          .gt("version", since)
          .lte("version", until)
        if (after) query = query.or(`version.gt.${after.version},and(version.eq.${after.version},file_id.gt.${after.id})`)
        return query.order("version").order("file_id").limit(PAGE)
      },
      (row) => {
        const parsed = z.object({ file_id: z.uuid(), version: z.number().int().positive() }).parse(row)
        return { id: parsed.file_id, version: parsed.version }
      },
    )
  }

  folders(projectId: string) {
    return this.keyset<string>(
      (after) => {
        let query = this.supabase.from("project_folders").select("path").eq("project_id", projectId)
        if (after !== null) query = query.gt("path", after)
        return query.order("path").limit(PAGE)
      },
      (row) => z.object({ path: ProjectPath }).parse(row).path,
    )
  }
}

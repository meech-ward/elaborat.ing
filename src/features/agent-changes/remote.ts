import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod/mini"
import { ProjectPath } from "../project-storage/model"
import { classify, RemoteError } from "../project-storage/remote"

/**
 * Agent changes as the database serves them (`supabase/schemas/agent_changes.sql`),
 * called as the signed-in user: the file versions agents saved in a project,
 * and the person's own marker of how far they have looked. Every response is
 * validated before it is used. Nothing here is kept on the device.
 */

const Person = z.nullable(z.object({ user_id: z.uuid(), email: z.nullable(z.string()), name: z.nullish(z.string()) }))
const Version = z.int().check(z.positive())
const Revision = z.int().check(z.nonnegative())
/** A content's size in bytes, or null when the version is a deletion. */
const Size = z.nullable(z.int().check(z.nonnegative()))

/** The most text a diff shows, both versions together, in bytes (get_agent_change refuses more). */
export const DIFF_LIMIT_BYTES = 1024 * 1024

/** One version an agent saved, with the file's version before it, without their contents (`contents` has them). */
export const AgentChange = z.object({
  file_id: z.uuid(),
  /** The project revision it was saved at: several files saved together share it. */
  version: Version,
  path: ProjectPath,
  /** The agent deleted the file. */
  deleted: z.boolean(),
  size: Size,
  created_at: z.string(),
  /** The person the agent saved it for, or null for a deleted account. */
  author: Person,
  /** The agent's name, as the person approved it, or null when it has none. */
  agent: z.nullable(z.string()),
  /** Still the file's newest version: nothing changed it since. */
  latest: z.boolean(),
  /** The file's version before this one, or null when the agent created the file. */
  previous: z.nullable(
    z.object({
      version: Version,
      path: ProjectPath,
      deleted: z.boolean(),
      size: Size,
      /** Its content is the same as this version's. */
      same_content: z.boolean(),
    }),
  ),
  /** The thread whose reply links this version, with its opening words (null when deleted). */
  thread: z.nullable(z.object({ id: z.uuid(), comment_id: z.uuid(), opening: z.nullable(z.string()) })),
})
export type AgentChange = z.infer<typeof AgentChange>

/** A page of a project's agent changes, newest first, with the caller's marker (`seen`) and whether older ones remain (`more`). */
export const AgentChangeList = z.object({
  project_id: z.uuid(),
  revision: Revision,
  seen: Revision,
  more: z.boolean(),
  changes: z.array(AgentChange),
})
export type AgentChangeList = z.infer<typeof AgentChangeList>

/** One change's content and its file's previous version's (null when the agent created the file); null content is a deletion. */
export const AgentChangeContents = z.object({
  file_id: z.uuid(),
  version: Version,
  content: z.nullable(z.string()),
  previous: z.nullable(z.object({ version: Version, content: z.nullable(z.string()) })),
})
export type AgentChangeContents = z.infer<typeof AgentChangeContents>

const Marked = z.object({ project_id: z.uuid(), seen: Revision })

export interface AgentChangesRemote {
  /** The newest changes, or those saved before the revision `before`. Anyone who can read the project. */
  list(projectId: string, before?: number): Promise<AgentChangeList>
  /**
   * One change's content and its previous version's, for its diff: refused
   * (a "limit" error) when they are larger than DIFF_LIMIT_BYTES together.
   * With `previousOnly`, for Revert, only the previous version's, at any size.
   */
  contents(projectId: string, fileId: string, version: number, previousOnly?: boolean): Promise<AgentChangeContents>
  /** How many changes are new to the caller, up to 100. */
  count(projectId: string): Promise<number>
  /** The caller has looked up to `version`; the marker only moves forward. */
  markSeen(projectId: string, version: number): Promise<number>
}

/** The error for a request that got no answer. */
export function offline(): RemoteError {
  return new RemoteError("network", "Agent changes need a connection.")
}

export class SupabaseAgentChangesRemote implements AgentChangesRemote {
  constructor(private readonly supabase: Pick<SupabaseClient, "rpc">) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let response
    try {
      response = await this.supabase.rpc(name, args)
    } catch {
      throw offline()
    }
    if (response.error) {
      const error = classify(response.error)
      throw error.kind === "network" ? offline() : error
    }
    return response.data
  }

  async list(projectId: string, before?: number) {
    return AgentChangeList.parse(await this.rpc("list_agent_changes", { project_id: projectId, ...(before === undefined ? {} : { before }) }))
  }

  async contents(projectId: string, fileId: string, version: number, previousOnly = false) {
    return AgentChangeContents.parse(
      await this.rpc("get_agent_change", { project_id: projectId, file_id: fileId, version, ...(previousOnly ? { previous_only: true } : {}) }),
    )
  }

  async count(projectId: string) {
    return Revision.parse(await this.rpc("count_agent_changes", { project_id: projectId }))
  }

  async markSeen(projectId: string, version: number) {
    return Marked.parse(await this.rpc("mark_agent_changes_seen", { project_id: projectId, version })).seen
  }
}

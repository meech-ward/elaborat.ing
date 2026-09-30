import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { ProjectPath } from "../project-storage/model"
import { classify, RemoteError } from "../project-storage/remote"

/**
 * Agent changes as the database serves them (`supabase/schemas/agent_changes.sql`),
 * called as the signed-in user: the file versions agents saved in a project,
 * and the person's own marker of how far they have looked. Every response is
 * validated before it is used. Nothing here is kept on the device.
 */

const Person = z.object({ user_id: z.uuid(), email: z.string().nullable(), name: z.string().nullish() }).nullable()

/** One version an agent saved, with the file's version before it. */
export const AgentChange = z.object({
  file_id: z.uuid(),
  /** The project revision it was saved at: several files saved together share it. */
  version: z.number().int().positive(),
  path: ProjectPath,
  /** The agent deleted the file. */
  deleted: z.boolean(),
  /** null when deleted. */
  content: z.string().nullable(),
  created_at: z.string(),
  /** The person the agent saved it for, or null for a deleted account. */
  author: Person,
  /** The agent's name, as the person approved it, or null when it has none. */
  agent: z.string().nullable(),
  /** Still the file's newest version: nothing changed it since. */
  latest: z.boolean(),
  /** The file's version before this one, or null when the agent created the file. */
  previous: z
    .object({ version: z.number().int().positive(), path: ProjectPath, deleted: z.boolean(), content: z.string().nullable() })
    .nullable(),
  /** The thread whose reply links this version, with its opening words (null when deleted). */
  thread: z.object({ id: z.uuid(), comment_id: z.uuid(), opening: z.string().nullable() }).nullable(),
})
export type AgentChange = z.infer<typeof AgentChange>

/** A page of a project's agent changes, newest first, with the caller's marker (`seen`) and whether older ones remain (`more`). */
export const AgentChangeList = z.object({
  project_id: z.uuid(),
  revision: z.number().int().nonnegative(),
  seen: z.number().int().nonnegative(),
  more: z.boolean(),
  changes: z.array(AgentChange),
})
export type AgentChangeList = z.infer<typeof AgentChangeList>

const Marked = z.object({ project_id: z.uuid(), seen: z.number().int().nonnegative() })

export interface AgentChangesRemote {
  /** The newest changes, or those saved before the revision `before`. Anyone who can read the project. */
  list(projectId: string, before?: number): Promise<AgentChangeList>
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

  async count(projectId: string) {
    return z.number().int().nonnegative().parse(await this.rpc("count_agent_changes", { project_id: projectId }))
  }

  async markSeen(projectId: string, version: number) {
    return Marked.parse(await this.rpc("mark_agent_changes_seen", { project_id: projectId, version })).seen
  }
}

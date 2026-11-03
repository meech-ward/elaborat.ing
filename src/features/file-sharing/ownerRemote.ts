import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod/mini"
import { ProjectPath } from "@/features/project-storage/model"
import { classify, RemoteError } from "@/features/project-storage/remote"

const timestamp = z.string().check(z.maxLength(64), z.refine(value => Number.isFinite(Date.parse(value))))
const FileShare = z.object({
  id: z.uuid(),
  file_id: z.uuid(),
  path: ProjectPath,
  token: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  created_at: timestamp,
  revoked_at: z.nullable(timestamp),
})

/** Owner-only metadata. The bearer token is never written into browser storage. */
export type OwnerFileShare = z.infer<typeof FileShare>

/** One specific account's file-link controls, independent of project membership invitations. */
export class OwnerFileSharingRemote {
  constructor(private readonly client: Pick<SupabaseClient, "auth" | "rpc">, private readonly userId: string) {}

  private async rpc(name: string, projectId: string, fileId: string, args: Record<string, unknown> = {}): Promise<OwnerFileShare | null> {
    z.uuid().parse(projectId)
    z.uuid().parse(fileId)
    try {
      const { data: { session }, error } = await this.client.auth.getSession()
      if (error) throw new RemoteError(!error.status || error.status >= 500 ? "network" : "access", "Could not check the signed-in account. Try again.")
      if (!session || session.user.id !== this.userId) throw new RemoteError("access", "The signed-in account changed. Open the project again before sharing a file.")
      // Bind only this RPC to the checked account: a later shared-client
      // session change must not run an old dialog's action as another person.
      const result = await this.client.rpc(name, { project_id: projectId, file_id: fileId, ...args }).setHeader("Authorization", `Bearer ${session.access_token}`)
      if (result.error) throw classify(result.error)
      if (result.data === null) return null
      const parsed = FileShare.safeParse(result.data)
      if (!parsed.success || parsed.data.file_id !== fileId) throw new RemoteError("invalid", "The sharing service returned data this app cannot use.")
      return parsed.data
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError("network", "Could not reach file sharing. Check your connection and try again.")
    }
  }

  get(projectId: string, fileId: string): Promise<OwnerFileShare | null> {
    return this.rpc("get_file_share", projectId, fileId)
  }

  set(projectId: string, fileId: string, enabled: boolean, replaceLink = false): Promise<OwnerFileShare | null> {
    return this.rpc("set_file_share", projectId, fileId, { enabled, replace_link: replaceLink })
  }
}

export function sharedFileHref(origin: string, token: string): string {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Invalid file link.")
  return new URL(`/s/${token}`, origin).href
}

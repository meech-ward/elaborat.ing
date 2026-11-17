import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod/mini"
import { ImageAssetSchema } from "../images/types"
import { byteLength, MAX_FILE_BYTES, ProjectPath } from "../project-storage/model"
import { classify, RemoteError, RemoteMember } from "../project-storage/remote"
import { historyDay } from "./grouping"

const Version = z.int().check(z.positive())
const Timestamp = z.string().check(
  z.maxLength(64),
  z.refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)), "A saved time needs an explicit timezone."),
)
const Day = z.string().check(z.refine(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && historyDay(`${value}T00:00:00Z`) === value))

const fields = {
  file_id: z.uuid(),
  version: Version,
  path: ProjectPath,
  kind: z.enum(["text", "image"]),
  asset: z.nullable(ImageAssetSchema),
  deleted: z.boolean(),
  author_id: z.nullable(z.uuid()),
  created_at: Timestamp,
}

export const FileVersion = z.object(fields).check(
  z.refine(row => row.kind === "image" ? row.asset !== null : row.asset === null, "The saved image metadata is incomplete."),
)
export type FileVersion = z.infer<typeof FileVersion>

export const FileVersionContent = z.object({
  ...fields,
  content: z.nullable(z.string().check(z.refine(value => byteLength(value) <= MAX_FILE_BYTES, "The saved file is larger than 2 MiB."))),
}).check(
  z.refine(row => row.deleted === (row.content === null), "The saved deletion does not match its content."),
  z.refine(row => row.kind === "image" ? row.asset !== null && (row.deleted || row.content === "") : row.asset === null, "The saved image metadata is incomplete."),
)
export type FileVersionContent = z.infer<typeof FileVersionContent>

/** Complete UTC days. `previous` is chronological lookahead, not necessarily the preceding revision. */
export type FileHistoryPage = { versions: FileVersion[]; more: boolean; previous: FileVersion | null }
export type FileHistoryAuthor = Pick<RemoteMember, "user_id" | "name" | "email">

export interface FileHistoryRemote {
  /** Complete calendar days, newest first; before excludes that UTC day and every later day. */
  list(projectId: string, fileId: string, before?: string): Promise<FileHistoryPage>
  content(projectId: string, fileId: string, version: number): Promise<FileVersionContent>
  /** The actual previous revision, even if transaction timestamps cross midnight out of order. */
  predecessor(projectId: string, fileId: string, version: number): Promise<FileVersion | null>
  authors(projectId: string): Promise<FileHistoryAuthor[]>
}

// These columns are explicitly granted in files.sql. In particular, selecting
// * would include agent_client_id, which readers must never receive.
const COLUMNS = "file_id,version,path,kind,asset,deleted,author_id,created_at"
const PAGE = 100
type Response = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string | null } | null }>

// Postgres keeps microseconds, while Date keeps milliseconds. Retain the final
// three fractional digits when checking the API's chronological keyset order.
function timeOf(timestamp: string): bigint {
  const fraction = /\.(\d+)(?:Z|[+-])/i.exec(timestamp)?.[1] ?? ""
  return BigInt(Date.parse(timestamp)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3))
}

/** Reads existing immutable records as the signed-in user, under their ordinary RLS. */
export class SupabaseFileHistoryRemote implements FileHistoryRemote {
  constructor(private readonly supabase: Pick<SupabaseClient, "from" | "rpc">) {}

  private async read(request: Response): Promise<unknown> {
    let response
    try { response = await request }
    catch { throw new RemoteError("network", "Version history needs a connection.") }
    if (response.error) throw classify(response.error)
    return response.data
  }

  private checkIdentity(row: FileVersion, projectId: string, fileId: string): void {
    if (row.file_id !== fileId || (row.asset && !row.asset.object_key.startsWith(`${projectId}/`))) {
      throw new RemoteError("invalid", "The saved version does not belong to this file.")
    }
  }

  async list(projectId: string, fileId: string, before?: string): Promise<FileHistoryPage> {
    z.uuid().parse(projectId)
    z.uuid().parse(fileId)
    if (before !== undefined) Day.parse(before)
    const versions: FileVersion[] = []
    let cursor: FileVersion | null = null
    for (;;) {
      let query = this.supabase.from("file_versions").select(COLUMNS).eq("project_id", projectId).eq("file_id", fileId)
      if (before !== undefined) query = query.lt("created_at", `${before}T00:00:00Z`)
      if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},version.lt.${cursor.version})`)
      const rows = z.array(FileVersion).check(z.maxLength(PAGE)).parse(await this.read(query.order("created_at", { ascending: false }).order("version", { ascending: false }).limit(PAGE)))
      let last = cursor
      for (const row of rows) {
        this.checkIdentity(row, projectId, fileId)
        if ((before !== undefined && historyDay(row.created_at) >= before)
          || (last && (timeOf(row.created_at) > timeOf(last.created_at) || (timeOf(row.created_at) === timeOf(last.created_at) && row.version >= last.version)))) {
          throw new RemoteError("invalid", "Saved versions arrived out of order.")
        }
        last = row
      }
      versions.push(...rows)
      if (rows.length < PAGE) return { versions, more: false, previous: null }
      const lastDay = historyDay(versions.at(-1)!.created_at)
      const boundary = versions.findIndex(row => historyDay(row.created_at) === lastDay)
      if (boundary > 0) return { versions: versions.slice(0, boundary), more: true, previous: versions[boundary] }
      // A busy day can exceed one API page. Continue until the day is whole;
      // the older lookahead is fetched again on the next requested page.
      cursor = versions.at(-1)!
    }
  }

  async predecessor(projectId: string, fileId: string, version: number): Promise<FileVersion | null> {
    z.uuid().parse(projectId)
    z.uuid().parse(fileId)
    Version.parse(version)
    const rows = z.array(FileVersion).check(z.maxLength(1)).parse(await this.read(
      this.supabase.from("file_versions").select(COLUMNS).eq("project_id", projectId).eq("file_id", fileId).lt("version", version).order("version", { ascending: false }).limit(1),
    ))
    const row = rows[0] ?? null
    if (row) {
      this.checkIdentity(row, projectId, fileId)
      if (row.version >= version) throw new RemoteError("invalid", "The previous saved version did not load.")
    }
    return row
  }

  async content(projectId: string, fileId: string, version: number): Promise<FileVersionContent> {
    z.uuid().parse(projectId)
    z.uuid().parse(fileId)
    Version.parse(version)
    const row = FileVersionContent.parse(await this.read(
      this.supabase.from("file_versions").select(`${COLUMNS},content`).eq("project_id", projectId).eq("file_id", fileId).eq("version", version).single(),
    ))
    this.checkIdentity(row, projectId, fileId)
    if (row.version !== version) throw new RemoteError("invalid", "The requested saved version did not load.")
    return row
  }

  async authors(projectId: string): Promise<FileHistoryAuthor[]> {
    z.uuid().parse(projectId)
    return z.array(RemoteMember).parse(await this.read(this.supabase.rpc("list_members", { project_id: projectId })))
      .map(({ user_id, email, name }) => ({ user_id, email, name }))
  }
}

import { z } from "zod/mini"
import type { LocalProject } from "./model"
import { MAX_SYNC_ERROR_DETAIL, safeSyncErrorDetail } from "./syncDiagnostics"

/** Optional UI metadata. Failure here must never stop a durable project save. */
export type SyncDiagnosticStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

const Diagnostic = z.strictObject({
  version: z.literal(1),
  reason: z.enum(["invalid", "limit"]),
  revision: z.int().check(z.nonnegative()),
  created: z.boolean(),
  role: z.nullable(z.enum(["owner", "editor", "commenter", "viewer"])),
  mutationId: z.nullable(z.uuid()),
  detail: z.string().check(z.maxLength(MAX_SYNC_ERROR_DETAIL), z.refine(detail => safeSyncErrorDetail(detail) === detail)),
})
export type SyncDiagnostic = z.infer<typeof Diagnostic>

/** Names, note contents, paths, backend error output and credentials are never copied here. */
export function projectDiagnostic(project: LocalProject): SyncDiagnostic | null {
  const detail = safeSyncErrorDetail(project.syncErrorDetail)
  if (!detail || project.syncError !== "invalid" && project.syncError !== "limit") return null
  return {
    version: 1, reason: project.syncError, revision: project.revision, created: project.created,
    role: project.role, mutationId: project.pending?.mutationId ?? null, detail,
  }
}

export function matchesDiagnostic(project: LocalProject, diagnostic: SyncDiagnostic): boolean {
  return project.syncError === diagnostic.reason && project.revision === diagnostic.revision && project.created === diagnostic.created &&
    project.role === diagnostic.role && (project.pending?.mutationId ?? null) === diagnostic.mutationId
}

function browserStorage(): SyncDiagnosticStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage } catch { return null }
}

/** Separate from v2 IndexedDB rows so older app tabs keep reading and saving them. */
export class ProjectDiagnosticStorage {
  private unavailable = false

  constructor(private readonly storage: SyncDiagnosticStorage | null = browserStorage()) {}

  private key(partition: string, projectId: string): string {
    return `elaborating:sync-diagnostic:v1:${JSON.stringify([partition, projectId])}`
  }

  read(partition: string, projectId: string): SyncDiagnostic | null {
    if (this.unavailable) return null
    let value: string | null | undefined
    try { value = this.storage?.getItem(this.key(partition, projectId)) }
    catch { this.unavailable = true; return null }
    if (!value || value.length > 1024) return null
    try {
      const parsed = Diagnostic.safeParse(JSON.parse(value))
      return parsed.success ? parsed.data : null
    } catch { return null }
  }

  write(partition: string, projectId: string, diagnostic: SyncDiagnostic | null): void {
    if (this.unavailable) return
    try {
      const key = this.key(partition, projectId)
      if (diagnostic) this.storage?.setItem(key, JSON.stringify(diagnostic))
      else this.storage?.removeItem(key)
    } catch {
      // Fail closed for this instance so a refused clear cannot show an older
      // explanation. The durable project state and its category still work.
      this.unavailable = true
    }
  }
}

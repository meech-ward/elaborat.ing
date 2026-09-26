import { z } from "zod"

/**
 * The on-device model for projects: what the browser keeps in IndexedDB so
 * people can open, edit and save while offline, and what sync sends to the
 * database's `save_files`.
 *
 * Each file keeps three layers:
 * - `base`: the copy the server has, as far as this device knows, with the
 *   server's file id, path and version (the project revision at which the
 *   file last changed). `null` when the server has no such file.
 * - `content`: the locally saved copy. `null` means deleted locally.
 * - `draft`: unsaved edits kept for recovery, never synced.
 *
 * A file is dirty when its saved copy differs from its base (content, path,
 * or existence). Sync works out what to send from that difference, so there
 * is no separate change log to replay.
 */

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024
export const MAX_ENTRIES = 4096

const encoder = new TextEncoder()
export const byteLength = (text: string): number => encoder.encode(text).length

/**
 * The database's path rule (`private.is_valid_path`): 1 to 1024 bytes of
 * NFC-normalized text; no leading, trailing or doubled slash; no segment
 * starting with a dot; no backslash, colon or control characters. C1
 * control characters are refused too, so this is never looser than the
 * database.
 */
export function isValidProjectPath(path: unknown): path is string {
  return typeof path === "string" && projectPathProblem(path) === null
}

/** Why a path breaks the rule above, in words a person can act on; null when it is valid. */
export function projectPathProblem(path: string): string | null {
  const bytes = byteLength(path)
  if (bytes < 1) return "The path is empty."
  if (bytes > 1024) return "The path is longer than 1024 bytes."
  if (path.normalize("NFC") !== path) return "The path is not in Unicode normal form C (NFC)."
  if (path.startsWith("/") || path.endsWith("/")) return "The path starts or ends with a slash."
  if (path.includes("//")) return "The path has an empty folder name (two slashes in a row)."
  if (/(^|\/)\./.test(path)) return "A name in the path starts with a dot."
  if (/[\\:]/.test(path)) return "The path has a backslash or a colon."
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return "The path has a control character."
  return null
}

export const ProjectPath = z.string().refine(isValidProjectPath, "Invalid project path")

export const Role = z.enum(["owner", "editor", "commenter", "viewer"])
export type Role = z.infer<typeof Role>

/** Roles that can change a project's files. */
export const canEdit = (role: Role | null): boolean => role === "owner" || role === "editor"

/** One change in a `save_files` batch, exactly as the database accepts it. */
export const SaveChange = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put"), path: ProjectPath, content: z.string(), base_version: z.number().int().positive().optional() }).strict(),
  z.object({ op: z.literal("delete"), path: ProjectPath, base_version: z.number().int().positive() }).strict(),
  z.object({ op: z.literal("move"), path: ProjectPath, to: ProjectPath, base_version: z.number().int().positive(), content: z.string().optional() }).strict(),
  z.object({ op: z.literal("mkdir"), path: ProjectPath }).strict(),
  z.object({ op: z.literal("rmdir"), path: ProjectPath }).strict(),
])
export type SaveChange = z.infer<typeof SaveChange>

/** The server's copy of a file, as this device last saw it. */
export const FileBase = z.object({
  id: z.uuid(),
  path: ProjectPath,
  version: z.number().int().positive(),
  content: z.string(),
}).strict()
export type FileBase = z.infer<typeof FileBase>

/** What the server had when a save of this file conflicted. */
export const FileConflict = z.object({
  /** The server's current copy, or null when the server no longer has the file. */
  current: z.object({ id: z.uuid(), version: z.number().int().positive(), content: z.string() }).strict().nullable(),
  /** Set instead when the save failed because the path is used by another file or folder. */
  pathTaken: z.boolean(),
}).strict()
export type FileConflict = z.infer<typeof FileConflict>

export const LocalFile = z.object({
  partition: z.string().min(1),
  projectId: z.uuid(),
  /** Stable on this device across moves, so an acknowledgement finds the file after it moved again. */
  localId: z.uuid(),
  /** The file's path on this device (its key). */
  path: ProjectPath,
  base: FileBase.nullable(),
  /** The locally saved copy. null means deleted locally. */
  content: z.string().nullable(),
  /** Files saved together share a batch id and are synced as one atomic change. */
  batch: z.string().nullable(),
  /** Unsaved edits, kept for recovery. `token` is the saved copy's revision the draft was based on. */
  draft: z.object({ content: z.string(), token: z.string().nullable() }).strict().nullable(),
  conflict: FileConflict.nullable(),
}).strict()
export type LocalFile = z.infer<typeof LocalFile>

export const LocalFolder = z.object({
  partition: z.string().min(1),
  projectId: z.uuid(),
  path: ProjectPath,
  /** The server has this explicit folder. */
  base: z.boolean(),
  /** This device has this explicit folder. */
  local: z.boolean(),
}).strict()
export type LocalFolder = z.infer<typeof LocalFolder>

/** A batch that has been sent, or is about to be; kept until it is acknowledged. */
export const PendingSave = z.object({
  mutationId: z.uuid(),
  changes: z.array(SaveChange).min(1).max(MAX_ENTRIES),
  /**
   * The local files in the batch, in the same order as the first `files.length`
   * changes, with exactly what was sent for each: the server path the file
   * ends up at (null for a delete) and its content (null for a delete).
   */
  files: z.array(z.object({ localId: z.uuid(), sentPath: ProjectPath.nullable(), sentContent: z.string().nullable() }).strict()),
  folders: z.array(z.object({ path: ProjectPath, local: z.boolean() }).strict()),
}).strict()
export type PendingSave = z.infer<typeof PendingSave>

export const LocalProject = z.object({
  partition: z.string().min(1),
  id: z.uuid(),
  title: z.string(),
  /** A title change made on this device and not yet sent. */
  pendingTitle: z.string().nullable(),
  role: Role.nullable(),
  /** The server revision this device has fully pulled. 0 before the first pull. */
  revision: z.number().int().nonnegative(),
  /** True once the server has the project (create_project acknowledged or it came from the server). */
  created: z.boolean(),
  archivedAt: z.string().nullable(),
  /** Why sync stopped for this project, if it did; local work is always kept. */
  syncError: z.enum(["access-lost", "archived", "limit", "invalid"]).nullable(),
  pending: PendingSave.nullable(),
}).strict()
export type LocalProject = z.infer<typeof LocalProject>

export type FileState = "clean" | "created" | "changed" | "moved" | "deleted"

/** How a file's saved copy differs from the server's copy. */
export function fileState(file: LocalFile): FileState {
  if (file.base === null) return file.content === null ? "clean" : "created"
  if (file.content === null) return "deleted"
  if (file.base.path !== file.path) return "moved"
  return file.base.content === file.content ? "clean" : "changed"
}

export const isDirty = (file: LocalFile): boolean => fileState(file) !== "clean"

/**
 * A file's paired D2 companions. A `.d2` source pairs with `<name>.excalidraw`
 * (its native scene) and `<name>.d2.json` (its sidecar); the companions pair
 * back with the source. They are always synced together.
 */
export function companionPaths(path: string): string[] {
  if (path.endsWith(".d2")) {
    const stem = path.slice(0, -".d2".length)
    return [`${stem}.excalidraw`, `${path}.json`]
  }
  if (path.endsWith(".d2.json")) {
    const source = path.slice(0, -".json".length)
    return [source, `${source.slice(0, -".d2".length)}.excalidraw`]
  }
  if (path.endsWith(".excalidraw")) {
    const source = `${path.slice(0, -".excalidraw".length)}.d2`
    return [source, `${source}.json`]
  }
  return []
}

/** The partition key: which backend and which account a device's data belongs to. */
export function partitionKey(backendUrl: string, userId: string): string {
  return JSON.stringify([new URL(backendUrl).origin, z.uuid().parse(userId)])
}

/**
 * The editor's revision token for a saved copy: the SHA-256 hex digest of its
 * content. The workbench compares these to detect edits made in another tab;
 * the server's integer version never leaves the storage layer.
 */
export async function contentToken(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(content))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

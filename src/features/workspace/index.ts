/**
 * Workspace feature public interface.
 *
 * Pure path policy, rename-destination and companion-path helpers, and the
 * shapes of file reads, writes and conflicts. The per-file storage layer
 * (roadmap phase 2 steps 5, 6 and 12) uses these; the stored version check
 * itself happens in the database's `save_files`.
 *
 * This module is browser-safe: no Node imports. The pure drawing summary
 * lives in `summary.ts`.
 */


export type AllowedExtension = ".md" | ".mdx" | ".excalidraw" | ".excalidraw.md" | ".d2" | ".json";

export interface WorkspaceFileRef {
  /** Workspace-relative path with `/` separators, e.g. `notes/plan.md`. */
  path: string;
  size: number;
  /** ISO mtime for display only; never used for CAS. */
  mtime: string;
  /** Opaque revision hash of the exact stored bytes. */
  revision: string;
}

export interface WorkspaceFileContent extends WorkspaceFileRef {
  content: string;
  /** Present only for a recovered durable local draft; null means never saved. */
  savedContent?: string | null;
}

export interface WorkspaceEntries {
  files: WorkspaceFileRef[];
  /** Canonical existing directory paths, excluding workspace root. */
  directories: string[];
}

export interface WorkspaceDirectoryOk {
  path: string;
}

export interface WorkspaceWriteInput {
  content: string;
  /**
   * Revision the writer based its edit on. `null` is only valid for a true
   * create; writing an existing file with `null`, or a missing file with a
   * non-null revision, is a conflict.
   */
  expectedRevision: string | null;
}

export interface WorkspaceWriteOk {
  path: string;
  revision: string;
  size: number;
}

export interface WorkspaceRenameInput {
  /** New basename (no separators) in the file's existing folder. */
  newName: string;
  /**
   * Revision the rename is based on. Always required: rename applies only
   * to an existing file, and a stale revision is a conflict carrying the
   * current content, exactly like a stale write.
   */
  expectedRevision: string;
}

export interface WorkspaceRenameOk {
  /** New workspace-relative path (same folder, new basename). */
  path: string;
  /** Revision of the renamed file (identical bytes, so usually unchanged). */
  revision: string;
  size: number;
}

export interface WorkspaceConflict {
  error: string;
  path: string;
  currentRevision: string;
  /** Current saved text so the UI can diff/reload without losing edits. */
  currentContent: string;
}

export interface WorkspaceApiError {
  error: string;
}

export type DrawingKind = "excalidraw" | "d2" | "markdown" | "json" | "unknown";

export interface DrawingSummary {
  path: string;
  revision: string;
  kind: DrawingKind;
  /** False when a JSON drawing failed to parse; content is still preserved. */
  parseOk: boolean;
  /** Element counts for Excalidraw scenes (by `type`), empty otherwise. */
  elementsByType: Record<string, number>;
  totalElements: number;
  /** Native text elements preserved in the scene. */
  textCount: number;
  /** Heuristic line counts for d2/markdown sources; null for JSON scenes. */
  lines: number | null;
}

/** Max accepted file content size (2 MiB of UTF-8). */
export const WORKSPACE_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const ALLOWED_SUFFIXES = [".excalidraw.md", ".md", ".mdx", ".excalidraw", ".d2", ".json"] as const;

/**
 * Syntactic path policy.
 * Rejects absolute paths, traversal (`..`), percent-encoded separators or
 * dots, backslashes, drive letters, dotfile segments, empty segments and
 * unsupported extensions. Returns the cleaned relative path or null.
 */
export function validateWorkspacePath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) return null;
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return null;
  }
  // A second decode pass catches double-encoded traversal (%252e -> %2e -> .).
  if (/%(?:2e|2f|5c)/i.test(decoded)) return null;
  if (decoded.includes("\\")) return null;
  if (decoded.startsWith("/") || /^[a-zA-Z]:/.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some((s) => s.length === 0)) return null;
  if (segments.some((s) => s === "." || s === "..")) return null;
  if (segments.some((s) => s.startsWith("."))) return null;
  const lower = decoded.toLowerCase();
  if (!ALLOWED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return null;
  return decoded;
}

export function isAllowedWorkspacePath(input: string): boolean {
  return validateWorkspacePath(input) !== null;
}

/** Basename of a workspace path (`notes/plan.md` -> `plan.md`). Pure. */
export function basenameForPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Longest matching allowed suffix of a workspace path, lowercased
 * (`.excalidraw.md` wins over `.md`), or null when there is none.
 */
export function workspacePathSuffix(path: string): string | null {
  const lower = path.toLowerCase();
  // Compound D2 sidecar suffix first: a `.d2.json` rename must stay a sidecar.
  if (lower.endsWith(".d2.json")) return ".d2.json";
  for (const suffix of ALLOWED_SUFFIXES) {
    if (lower.endsWith(suffix)) return suffix;
  }
  return null;
}

/**
 * Single-segment rename name policy. The name must be one path segment:
 * no separators, backslashes, NUL bytes or control characters, no leading
 * dot, never `.`/`..`, and bounded in length. Extension and destination
 * checks live in `renameDestinationPath`. Returns the name or null.
 */
export function validateWorkspaceBasename(name: string): string | null {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (/[\x00-\x1f\x7f]/.test(name)) return null;
  if (name === "." || name === "..") return null;
  if (name.startsWith(".")) return null;
  return name;
}

/** Directory wire path: decode each segment once, with the file path's guards. */
export function validateWorkspaceDirectoryPath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) return null;
  let segments: string[];
  try {
    segments = input.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (segments.some((segment) => validateWorkspaceBasename(segment) === null)) return null;
  const path = segments.join("/");
  if (/^[a-zA-Z]:/.test(path) || /%(?:2e|2f|5c)/i.test(path)) return null;
  return path;
}

/**
 * Destination for renaming `source` to `newName` in its existing folder.
 * Requires: source validates, the name is one valid segment, the joined
 * destination validates to exactly itself (so `%`-sequences cannot make the
 * addressed file differ from the on-disk name), the destination keeps the
 * source's extension (same file kind; no silent `.d2` -> `.md` retyping),
 * and the destination differs from the source. Returns the destination or
 * null. No storage access; the save re-checks existence atomically.
 */
export function renameDestinationPath(source: string, newName: string): string | null {
  // Callers supply canonical list/read identities, not encoded wire paths.
  // Encode once before validation so literal percent sequences never move
  // a file into a different decoded folder.
  const cleanSource = validateWorkspacePath(source.split("/").map(encodeURIComponent).join("/"));
  const cleanName = validateWorkspaceBasename(newName);
  if (!cleanSource || !cleanName) return null;
  const slash = cleanSource.lastIndexOf("/");
  const raw = slash === -1 ? cleanName : `${cleanSource.slice(0, slash)}/${cleanName}`;
  if (validateWorkspacePath(raw) !== raw) return null;
  if (raw === cleanSource) return null;
  if (workspacePathSuffix(raw) !== workspacePathSuffix(cleanSource)) return null;
  return raw;
}

/**
 * Candidate generated companions coupled to `path`, without touching the
 * storage. A `.d2` source pairs with `<name>.excalidraw` (its native scene)
 * and `<name>.d2.json` (its sidecar, as in `structuredClient.sidecarPathFor`),
 * while a `.excalidraw` scene or `.d2.json` sidecar pairs back with its `.d2`
 * source. A rename refuses to separate companions that exist. Returns [] for uncoupled kinds.
 */
export function diagramPartnerPaths(path: string): string[] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d2")) {
    return [`${path.slice(0, -".d2".length)}.excalidraw`, `${path}.json`];
  }
  if (lower.endsWith(".excalidraw")) {
    return [`${path.slice(0, -".excalidraw".length)}.d2`];
  }
  if (lower.endsWith(".d2.json")) {
    return [path.slice(0, -".json".length)];
  }
  return [];
}

/** True for file kinds that can hold workspace references (links/embeds). */
export function canHoldWorkspaceRefs(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}

/** Type guard for conflict results. */
export function isWorkspaceConflict(value: unknown): value is WorkspaceConflict {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.error === "string" &&
    typeof v.path === "string" &&
    typeof v.currentRevision === "string" &&
    typeof v.currentContent === "string"
  );
}

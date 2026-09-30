import { z } from "zod/mini";
import { isCanonicalDirectoryPath } from "./folderTree";

/**
 * Browser-local folder explorer preferences.
 *
 * Path metadata only: expanded directory paths plus the selected creation
 * destination ("" is an explicit Workspace root, null is no selection).
 * No file contents, revisions, or drafts. Bounded, versioned, and
 * Zod-validated; bad or unavailable storage always
 * falls back to in-memory defaults instead of blocking use.
 */

export const FOLDER_STORAGE_KEY = "elaborating.folders.v1";
export const FOLDER_PREFS_VERSION = 1 as const;
export const MAX_EXPANDED_FOLDERS = 64;

const folderPrefsSchema = z.object({
  version: z.literal(FOLDER_PREFS_VERSION),
  expanded: z.array(z.string().check(z.minLength(1), z.maxLength(512))),
  selectedFolder: z.nullable(z.string().check(z.maxLength(512))),
});

export interface FolderPreferences {
  expanded: string[];
  /** "" selects the workspace root; null keeps kind-specific defaults. */
  selectedFolder: string | null;
}

export function defaultFolderPreferences(): FolderPreferences {
  return { expanded: [], selectedFolder: null };
}

function sanitizeExpanded(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of paths) {
    if (!isCanonicalDirectoryPath(raw) || seen.has(raw)) continue;
    seen.add(raw);
    clean.push(raw);
    if (clean.length >= MAX_EXPANDED_FOLDERS) break;
  }
  return clean;
}

function sanitizeSelection(value: string | null): string | null {
  if (value === null) return null;
  if (value === "") return "";
  return isCanonicalDirectoryPath(value) ? value : null;
}

/**
 * Validate an unknown persisted value. Always returns usable preferences:
 * missing, malformed, or wrong-version records become defaults, and
 * unusable entries are dropped while usable ones are kept.
 */
export function parseFolderPreferences(value: unknown): FolderPreferences {
  const parsed = folderPrefsSchema.safeParse(value);
  if (!parsed.success) return defaultFolderPreferences();
  return {
    expanded: sanitizeExpanded(parsed.data.expanded),
    selectedFolder: sanitizeSelection(parsed.data.selectedFolder),
  };
}

export function readFolderPreferences(
  storage: Pick<Storage, "getItem"> | null | undefined,
): FolderPreferences {
  try {
    if (storage == null || typeof storage.getItem !== "function")
      return defaultFolderPreferences();
    const raw = storage.getItem(FOLDER_STORAGE_KEY);
    if (raw == null) return defaultFolderPreferences();
    return parseFolderPreferences(JSON.parse(raw));
  } catch {
    return defaultFolderPreferences();
  }
}

export function writeFolderPreferences(
  storage: Pick<Storage, "setItem"> | null | undefined,
  value: FolderPreferences,
): void {
  try {
    if (storage == null || typeof storage.setItem !== "function") return;
    const expanded = sanitizeExpanded(value.expanded);
    const selectedFolder = sanitizeSelection(value.selectedFolder);
    storage.setItem(
      FOLDER_STORAGE_KEY,
      JSON.stringify({
        version: FOLDER_PREFS_VERSION,
        expanded,
        selectedFolder,
      }),
    );
  } catch {
    // Storage unavailable or quota-exceeded: keep in-memory state.
  }
}

/**
 * A folder is moving from `from` to `to`: its expanded folders are also
 * expanded at their new paths, and a selection inside it goes with it. The
 * old paths stay until a list shows them gone, so a list refreshed during
 * the move keeps the folder expanded wherever it is.
 */
export function followFolderMove(prefs: FolderPreferences, from: string, to: string): FolderPreferences {
  const moved = (path: string) => (path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null);
  const added = prefs.expanded.flatMap((path) => moved(path) ?? []);
  const selectedFolder = prefs.selectedFolder === null ? null : (moved(prefs.selectedFolder) ?? prefs.selectedFolder);
  if (added.length === 0 && selectedFolder === prefs.selectedFolder) return prefs;
  return { expanded: sanitizeExpanded([...added, ...prefs.expanded]), selectedFolder };
}

/**
 * Drop expanded/selected paths that no longer exist. Call only after a
 * SUCCESSFUL authoritative list: `keep` is the union of stored folder
 * paths, implied ancestors of listed files, and implied ancestors of open
 * unsaved drafts, so a folder backing an open draft is never pruned. A
 * failed list must never prune — absence of evidence is not absence.
 * The explicit root selection ("") always survives.
 */
export function pruneFolderPreferences(
  prefs: FolderPreferences,
  keep: readonly string[],
): FolderPreferences {
  const alive = new Set(keep);
  const expanded = prefs.expanded.filter((path) => alive.has(path));
  const selectedFolder =
    prefs.selectedFolder === null ||
    prefs.selectedFolder === "" ||
    alive.has(prefs.selectedFolder)
      ? prefs.selectedFolder
      : null;
  if (
    expanded.length === prefs.expanded.length &&
    selectedFolder === prefs.selectedFolder
  )
    return prefs;
  return { expanded, selectedFolder };
}

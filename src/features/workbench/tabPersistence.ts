import { z } from "zod/mini";
import { isValidProjectPath } from "@/features/project-storage/model";
import { MissingFileError } from "./workspaceStore";

/**
 * Browser-local record of which workspace tabs are open.
 *
 * Path metadata only: ordered saved-file paths plus the active path. No
 * document text, revisions, secrets, drafts, editor state or undo. Saved
 * files are identified by membership in the file list at write time, so
 * never-saved drafts are excluded without trusting stale tab revisions.
 */

export const TAB_STORAGE_KEY = "elaborating.tabs.v1";
export const TAB_PERSISTENCE_VERSION = 1 as const;
export const MAX_PERSISTED_TABS = 32;

const persistedTabsSchema = z.object({
  version: z.literal(TAB_PERSISTENCE_VERSION),
  openPaths: z.array(z.string().check(z.minLength(1), z.maxLength(512))),
  activePath: z.nullable(z.string().check(z.minLength(1), z.maxLength(512))),
});

export interface PersistedTabs {
  openPaths: string[];
  activePath: string | null;
}

/** A stored path is kept only if it is exactly a valid project path. */
function validateCanonicalPath(raw: string): string | null {
  return typeof raw === "string" && isValidProjectPath(raw) ? raw : null;
}

function sanitizePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of paths) {
    const path = validateCanonicalPath(raw);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    clean.push(path);
    if (clean.length >= MAX_PERSISTED_TABS) break;
  }
  return clean;
}

function resolveActive(
  openPaths: readonly string[],
  activePath: string | null,
): string | null {
  if (openPaths.length === 0) return null;
  if (activePath !== null) {
    const clean = validateCanonicalPath(activePath);
    if (clean !== null && openPaths.includes(clean)) return clean;
  }
  return openPaths[openPaths.length - 1];
}

/**
 * Validate an unknown persisted value. Returns null when there is no
 * usable record (missing, malformed, wrong version, no usable paths);
 * an explicitly empty tab set is a valid record with openPaths [] and
 * activePath null.
 */
export function parsePersistedTabs(value: unknown): PersistedTabs | null {
  const parsed = persistedTabsSchema.safeParse(value);
  if (!parsed.success) return null;
  const openPaths = sanitizePaths(parsed.data.openPaths);
  if (parsed.data.openPaths.length > 0 && openPaths.length === 0) return null;
  return {
    openPaths,
    activePath: resolveActive(openPaths, parsed.data.activePath),
  };
}

export function readPersistedTabs(
  storage: Pick<Storage, "getItem"> | null | undefined,
): PersistedTabs | null {
  try {
    if (storage == null || typeof storage.getItem !== "function") return null;
    const raw = storage.getItem(TAB_STORAGE_KEY);
    if (raw == null) return null;
    return parsePersistedTabs(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Project open tabs to the persisted record. Only paths present in
 * savedPaths (the current file list) are kept, in tab order with
 * the active tab preserved when it is a saved file.
 */
export function toPersistedTabs(
  tabs: readonly { path: string }[],
  active: string | null,
  savedPaths: readonly string[],
): PersistedTabs {
  const saved = new Set(savedPaths);
  const seen = new Set<string>();
  const openPaths: string[] = [];
  for (const tab of tabs) {
    const path = validateCanonicalPath(tab.path);
    if (path === null || seen.has(path) || !saved.has(path)) continue;
    seen.add(path);
    openPaths.push(path);
    if (openPaths.length >= MAX_PERSISTED_TABS) break;
  }
  return { openPaths, activePath: resolveActive(openPaths, active) };
}

/** Keep temporarily unreadable identities without reviving deliberately closed
 * loaded tabs. Current tabs still own selection and newly opened identities. */
export function retainUnrestoredTabs(
  current: PersistedTabs,
  remembered: PersistedTabs | null,
  unresolved: readonly string[],
): PersistedTabs {
  if (!remembered || unresolved.length === 0) return current;
  const keep = new Set([...current.openPaths, ...unresolved]);
  const openPaths = sanitizePaths([
    ...remembered.openPaths.filter((path) => keep.has(path)),
    ...current.openPaths,
  ]);
  return {
    openPaths,
    activePath: resolveActive(openPaths, current.activePath),
  };
}

export function writePersistedTabs(
  storage: Pick<Storage, "setItem"> | null | undefined,
  value: PersistedTabs,
): void {
  try {
    if (storage == null || typeof storage.setItem !== "function") return;
    const openPaths = sanitizePaths(value.openPaths);
    const activePath = resolveActive(openPaths, value.activePath);
    storage.setItem(
      TAB_STORAGE_KEY,
      JSON.stringify({
        version: TAB_PERSISTENCE_VERSION,
        openPaths,
        activePath,
      }),
    );
  } catch {
    // Storage unavailable or quota-exceeded: keep in-memory state.
  }
}

/** A missing file means the remembered tab is gone; anything else is transient. */
export function isMissingFileError(error: unknown): boolean {
  return error instanceof MissingFileError;
}

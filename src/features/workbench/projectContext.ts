import { z } from "zod";
import { isValidProjectPath } from "@/features/project-storage/model";

/**
 * Per-project workbench context: which saved files were
 * open, which was active, and which view each file used, so opening a
 * project resumes its previous context.
 *
 * Pure policy, no React or browser imports. Persisted records are validated
 * with Zod at this boundary; contexts store metadata only, NEVER file
 * bytes, drafts, revisions or tokens.
 */

export const PROJECT_CONTEXT_VERSION = 1 as const;
export const MAX_PROJECT_CONTEXT_TABS = 32;

/**
 * Generous input bound (matching the workspace 4096-entry scan bound) so
 * absurd persisted payloads are rejected outright instead of processed.
 * Surviving records are still truncated to MAX_PROJECT_CONTEXT_TABS.
 */
const MAX_PROJECT_CONTEXT_INPUT_ENTRIES = 4096;

export type ProjectContext = {
  version: 1;
  openPaths: string[];
  activePath: string | null;
  views: Record<string, "source" | "rendered" | "code" | "canvas">;
};

const projectViewSchema = z.enum(["source", "rendered", "code", "canvas"]);

const projectContextSchema = z.object({
  version: z.literal(PROJECT_CONTEXT_VERSION),
  openPaths: z
    .array(z.string().min(1).max(512))
    .max(MAX_PROJECT_CONTEXT_INPUT_ENTRIES),
  activePath: z.string().min(1).max(512).nullable(),
  views: z
    .record(z.string().min(1).max(512), projectViewSchema)
    .refine(
      (views) =>
        Object.keys(views).length <= MAX_PROJECT_CONTEXT_INPUT_ENTRIES,
    ),
});

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
    if (clean.length >= MAX_PROJECT_CONTEXT_TABS) break;
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

function sanitizeViews(
  views: Readonly<Record<string, "source" | "rendered" | "code" | "canvas">>,
  openPaths: readonly string[],
): Record<string, "source" | "rendered" | "code" | "canvas"> {
  const open = new Set(openPaths);
  const clean: Record<string, "source" | "rendered" | "code" | "canvas"> = {};
  for (const [path, view] of Object.entries(views)) {
    // Membership in the cleaned open set implies a canonical path.
    if (open.has(path)) clean[path] = view;
  }
  return clean;
}

/**
 * Validate an unknown persisted value. Returns null when there is no
 * usable record (missing, malformed, wrong version, oversized, or no
 * usable paths); an explicitly empty context is valid. Unknown fields
 * (bytes, drafts, tokens, revisions) are stripped, never trusted.
 */
export function parseProjectContext(value: unknown): ProjectContext | null {
  const parsed = projectContextSchema.safeParse(value);
  if (!parsed.success) return null;
  const openPaths = sanitizePaths(parsed.data.openPaths);
  if (parsed.data.openPaths.length > 0 && openPaths.length === 0) return null;
  return {
    version: PROJECT_CONTEXT_VERSION,
    openPaths,
    activePath: resolveActive(openPaths, parsed.data.activePath),
    views: sanitizeViews(parsed.data.views, openPaths),
  };
}

/**
 * Build a coherent context snapshot: invalid paths dropped, duplicates
 * removed with order retained, at most MAX_PROJECT_CONTEXT_TABS kept, the
 * active path resolved to an open path (or the deterministic last-tab
 * fallback), and views kept only for open paths.
 */
export function createProjectContext(
  openPaths: readonly string[],
  activePath: string | null,
  views: Readonly<
    Record<string, "source" | "rendered" | "code" | "canvas">
  >,
): ProjectContext {
  const clean = sanitizePaths(openPaths);
  return {
    version: PROJECT_CONTEXT_VERSION,
    openPaths: clean,
    activePath: resolveActive(clean, activePath),
    views: sanitizeViews(views, clean),
  };
}

import { isAllowedWorkspacePath } from "@/features/workspace"
import { decodeString } from "micromark-util-decode-string"

/**
 * Named file references in a document source.
 *
 * The workbench parses these from the AUTHORITATIVE source text it already
 * holds (never from evaluated MDX output), so an untrusted document script
 * cannot supply arbitrary file paths: only literal references present in
 * the saved source resolve, and only to workspace-allowed paths. The
 * rendered iframe receives no file access from this; it only gets pixels.
 *
 * Supported forms:
 * - Markdown links: [label](drawings/note.excalidraw)
 * - Drawing tags:   <Drawing src="drawings/note.excalidraw" />
 * - Diagram tags:   <Diagram src="diagrams/flow.d2" />
 */

export type RefKind = "link" | "drawing" | "diagram";

export interface SourceRef {
  kind: RefKind;
  /** Workspace-relative value of the literal source reference. */
  path: string;
  /** Link label, or the tag name for embeds. */
  label: string;
}

function cleanLinkTarget(target: string): string | null {
  const trimmed = decodeString(target.trim());
  if (!trimmed) return null;
  // Fragments/queries never address workspace files.
  const bare = trimmed.split("#")[0]?.split("?")[0] ?? "";
  if (!bare) return null;
  // External, absolute, and mailto-style targets are never workspace refs.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(bare)) return null;
  if (bare.startsWith("/") || bare.startsWith("./") || bare.startsWith("../")) return null;
  let path: string;
  try { path = decodeURIComponent(bare); } catch { return null; }
  if (!isCanonicalWorkspacePath(path)) return null;
  return path;
}

/** Literals are canonical file identities; the shared validator accepts wire encoding. */
function isCanonicalWorkspacePath(path: string): boolean {
  try { return isAllowedWorkspacePath(path.split("/").map(encodeURIComponent).join("/")); }
  catch { return false; }
}

// A valid 512-character wire path can have a longer JSX entity spelling.
// Keep extraction bounded while allowing the move planner's emitted literals.
const LINK_PATTERN = /\[([^\]\n]{1,120})\]\(([^)\s\n]{1,4096})\)/g;
const TAG_PATTERN = /<(Drawing|Diagram)\s+src=(?:"([^"]{1,4096})"|'([^']{1,4096})')\s*\/>/g;

/** Decode the escapes emitted by source assistance and the rendered literal
 * editor once, just as JSX does. No evaluated prop or child message becomes
 * authority here; the decoded source literal still passes the path policy. */
function decodeResourceLiteral(raw: string): string {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    '#39': "'", '#10': '\n', '#13': '\r',
  };
  return raw.replace(/&(amp|lt|gt|quot|apos|#39|#10|#13);/g, (_match, entity: string) => entities[entity]);
}

/** Parse literal file references from authoritative document source. */
export function parseSourceRefs(source: string): SourceRef[] {
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  const push = (kind: RefKind, path: string, label: string) => {
    const key = `${kind}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, path, label });
  };

  LINK_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(LINK_PATTERN)) {
    const cleaned = cleanLinkTarget(match[2] ?? "");
    if (cleaned) push("link", cleaned, match[1] ?? cleaned);
  }

  TAG_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(TAG_PATTERN)) {
    const tag = match[1] === "Diagram" ? "diagram" : "drawing";
    const raw = decodeResourceLiteral(match[2] ?? match[3] ?? "");
    if (raw && isCanonicalWorkspacePath(raw)) push(tag, raw, match[1] ?? raw);
  }

  return refs;
}

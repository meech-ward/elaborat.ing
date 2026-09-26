import type { DrawingKind, DrawingSummary } from "./index.ts";

/**
 * Pure drawing summary helper (no library/UI imports).
 * The raw file content stays the authority; this only derives counts for
 * display. Never throws on malformed input: unparseable JSON reports
 * `parseOk: false` and the stored file still keeps the bytes as text.
 */
export function summarizeDrawing(
  path: string,
  content: string,
  revision: string,
): DrawingSummary {
  const lower = path.toLowerCase();
  if (lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.md") || lower.endsWith(".json")) {
    return summarizeJsonScene(path, content, revision, lower.endsWith(".json") ? "json" : "excalidraw");
  }
  if (lower.endsWith(".d2")) {
    const lines = content.split("\n");
    const codeLines = lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
    const connections = codeLines.filter((l) => l.includes("->") || l.includes("--") || l.includes("<->")).length;
    return {
      path,
      revision,
      kind: "d2",
      parseOk: true,
      elementsByType: { declarations: codeLines.length - connections, connections },
      totalElements: codeLines.length,
      textCount: 0,
      lines: lines.length,
    };
  }
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    const lines = content.split("\n");
    const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
    const fences = lines.filter((l) => l.trim().startsWith("```")).length;
    return {
      path,
      revision,
      kind: "markdown",
      parseOk: true,
      elementsByType: { headings, codeFences: Math.floor(fences / 2) },
      totalElements: headings,
      textCount: 0,
      lines: lines.length,
    };
  }
  return {
    path,
    revision,
    kind: "unknown",
    parseOk: true,
    elementsByType: {},
    totalElements: 0,
    textCount: 0,
    lines: content.split("\n").length,
  };
}

function summarizeJsonScene(
  path: string,
  content: string,
  revision: string,
  fallbackKind: DrawingKind,
): DrawingSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      path,
      revision,
      kind: fallbackKind,
      parseOk: false,
      elementsByType: {},
      totalElements: 0,
      textCount: 0,
      lines: null,
    };
  }
  const elements =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { elements?: unknown }).elements)
      ? ((parsed as { elements: unknown[] }).elements as Array<Record<string, unknown>>)
      : null;
  if (elements === null) {
    // Ordinary JSON sidecar: valid JSON, not a scene. Preserve as-is.
    return {
      path,
      revision,
      kind: "json",
      parseOk: true,
      elementsByType: {},
      totalElements: 0,
      textCount: 0,
      lines: null,
    };
  }
  const elementsByType: Record<string, number> = {};
  let textCount = 0;
  for (const el of elements) {
    const type = typeof el?.type === "string" ? el.type : "unknown";
    elementsByType[type] = (elementsByType[type] ?? 0) + 1;
    // A text element counts when it carries actual text; unexpected native
    // fields are ignored here and preserved in the raw content.
    if (type === "text" && typeof el.text === "string" && el.text.length > 0) textCount += 1;
  }
  return {
    path,
    revision,
    kind: "excalidraw",
    parseOk: true,
    elementsByType,
    totalElements: elements.length,
    textCount,
    lines: null,
  };
}

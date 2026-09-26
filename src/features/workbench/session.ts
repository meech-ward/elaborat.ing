/**
 * Open-file state (pure logic).
 *
 * Source text and dirty tracking stay in the document store; this module
 * owns the workspace sidecar for the open file: where it lives, which CAS
 * revision it was opened at, and what a failed save means. Source identity
 * (store docId) and saved revision are distinct concepts on
 * purpose: reopening the same bytes advances the identity but keeps the
 * revision, while an external agent edit changes the revision only.
 */

export type FileKind = "note" | "drawing" | "diagram" | "text";

export function kindForPath(path: string): FileKind {
  const lower = path.toLowerCase();
  // Native drawing wrappers first: `.excalidraw.md` also ends with `.md`.
  if (lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.md")) return "drawing";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "note";
  if (lower.endsWith(".d2")) return "diagram";
  return "text";
}

export type EditorLanguage = "markdown" | "mdx" | "json" | "plaintext" | "d2";

/** Monaco language for a workspace path (d2 has a local grammar; never MDX). */
export function editorLanguageForPath(path: string): EditorLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mdx")) return "mdx";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json") || lower.endsWith(".excalidraw")) return "json";
  if (lower.endsWith(".d2")) return "d2";
  return "plaintext";
}

/** Untitled names avoid every path the workspace already lists. */
export function suggestUntitledName(existing: readonly string[], extension = ".md", dir = "notes"): string {
  const taken = new Set(existing.map((p) => p.toLowerCase()));
  // An explicit root destination ("") names at the root (`untitled.md`),
  // never `/untitled.md`; every other folder keeps `dir/untitled` joining.
  const base = dir === "" ? "untitled" : `${dir}/untitled`;
  if (!taken.has(`${base}${extension}`)) return `${base}${extension}`;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type SaveStatus =
  | { stage: "idle" }
  | { stage: "saving" }
  | {
      stage: "conflict"
      /** Current saved text so the UI can offer reload/overwrite. */
      currentRevision: string
      currentContent: string
    };

export interface OpenFile {
  /** Workspace path, or null for a not-yet-created note. */
  path: string | null;
  /** Pending name for a not-yet-created note. */
  pendingName: string | null;
  /** CAS revision the buffer is based on; null when never saved. */
  baseRevision: string | null;
  kind: FileKind;
  save: SaveStatus;
  /** A reload saw a newer saved revision while the buffer was dirty. */
  serverChanged: { currentRevision: string; currentContent: string } | null;
}

export function initialOpenFile(): OpenFile {
  return {
    path: null,
    pendingName: null,
    baseRevision: null,
    kind: "note",
    save: { stage: "idle" },
    serverChanged: null,
  };
}

export function openWorkspaceFile(path: string, revision: string): OpenFile {
  return {
    path,
    pendingName: null,
    baseRevision: revision,
    kind: kindForPath(path),
    save: { stage: "idle" },
    serverChanged: null,
  };
}

export function newUntitledNote(name: string): OpenFile {
  return {
    path: null,
    pendingName: name,
    baseRevision: null,
    kind: "note",
    save: { stage: "idle" },
    serverChanged: null,
  };
}

/** Effective save target: the open path, or the pending name for new notes. */
export function saveTarget(file: OpenFile): string | null {
  return file.path ?? file.pendingName;
}

export function markSaving(file: OpenFile): OpenFile {
  return { ...file, save: { stage: "saving" }, serverChanged: null };
}

export function markSaved(file: OpenFile, path: string, revision: string): OpenFile {
  return {
    ...file,
    path,
    pendingName: null,
    baseRevision: revision,
    kind: kindForPath(path),
    save: { stage: "idle" },
    serverChanged: null,
  };
}

export function markConflict(
  file: OpenFile,
  conflict: { currentRevision: string; currentContent: string },
): OpenFile {
  return { ...file, save: { stage: "conflict", ...conflict }, serverChanged: null };
}

/**
 * Async save completion stays attached to the captured document identity
 * a write that finishes after the user opened a
 * different file must not mark the new file saved. Returns how the caller
 * should settle the completion.
 */
export type SaveCompletion =
  | { outcome: "saved-current" }
  | { outcome: "saved-with-newer-edits" }
  | { outcome: "saved-other-file"; path: string };

export function resolveSaveCompletion(
  captured: { docId: number; path: string; text: string },
  current: { docId: number; text: string },
): SaveCompletion {
  if (current.docId !== captured.docId) {
    return { outcome: "saved-other-file", path: captured.path };
  }
  if (current.text !== captured.text) {
    return { outcome: "saved-with-newer-edits" };
  }
  return { outcome: "saved-current" };
}

export function clearSave(file: OpenFile): OpenFile {
  return { ...file, save: { stage: "idle" } };
}

/**
 * Apply a reload read. Clean buffer (or same revision): adopt the saved
 * text. Dirty buffer with a newer revision: keep the user's text and flag
 * the saved change (with its content) for an explicit choice. Never
 * silently replaces edits.
 */
export function applyReload(
  file: OpenFile,
  read: { revision: string; content: string },
  dirty: boolean,
): { file: OpenFile; adopt: boolean } {
  if (file.baseRevision === null || read.revision === file.baseRevision || !dirty) {
    const next: OpenFile = {
      ...file,
      baseRevision: read.revision,
      save: { stage: "idle" },
      serverChanged: null,
    };
    return { file: next, adopt: true };
  }
  const next: OpenFile = {
    ...file,
    serverChanged: { currentRevision: read.revision, currentContent: read.content },
  };
  return { file: next, adopt: false };
}

/**
 * Explorer file-row actions.
 *
 * Pure helpers for the per-file context menu: copy payloads, rename
 * preflight messages, and a clipboard writer with a legacy fallback.
 * The stored rename stays authoritative; these messages mirror its
 * refusals so the rename dialog validates inline before any save.
 */
import {
  basenameForPath,
  renameDestinationPath,
  validateWorkspaceBasename,
  validateWorkspacePath,
  workspacePathSuffix,
} from "@/features/workspace";

export interface ExplorerCopyPayload {
  /** Basename for "Copy filename" (`notes/plan.md` -> `plan.md`). */
  filename: string;
  /** Full workspace-relative path for "Copy path" (the MDX embed form). */
  fullPath: string;
}

export function copyPayloadForPath(path: string): ExplorerCopyPayload {
  return { filename: basenameForPath(path), fullPath: path };
}

/**
 * Write text to the clipboard. Prefers the async clipboard API and falls
 * back to a transient textarea + `execCommand` for contexts where it is
 * missing or refused (non-secure origins, older engines). Throws an
 * `Error` with a user-facing message when both paths fail; callers
 * surface that message visibly instead of failing silently.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  const clipboard =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path below.
    }
  }
  if (typeof document === "undefined") {
    throw new Error("clipboard is unavailable in this browser");
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    if (!ok) throw new Error("the browser refused the copy");
  } finally {
    area.remove();
  }
}

/**
 * Inline rename validation for the dialog. Returns null when `newName`
 * yields a valid same-folder destination, else a user-facing reason that
 * mirrors the stored rename's refusal (unchanged name, invalid name, undecodable
 * destination, or extension change). Dirty/open-draft and existence
 * checks happen at submit time against live workbench state.
 */
export function renameNameError(source: string, newName: string): string | null {
  if (renameDestinationPath(source, newName)) return null;
  if (!validateWorkspaceBasename(newName)) {
    return "Use one file name without separators, leading dots, or control characters.";
  }
  const slash = source.lastIndexOf("/");
  const raw = slash === -1 ? newName : `${source.slice(0, slash)}/${newName}`;
  if (raw === source) return "That is the current name; nothing to rename.";
  if (validateWorkspacePath(raw) !== raw) {
    return `"${newName}" cannot be a workspace file name here; keep an allowed extension.`;
  }
  const suffix = workspacePathSuffix(source);
  return suffix
    ? `This version keeps the same extension; the new name must end with "${suffix}".`
    : "This version keeps the same extension.";
}

/**
 * Length of the rename stem (basename minus its extension) used to
 * preselect the editable part of the name in the rename dialog.
 */
export function renameStemLength(path: string): number {
  const base = basenameForPath(path);
  const suffix = workspacePathSuffix(path);
  if (!suffix || base.length <= suffix.length) return base.length;
  return base.length - suffix.length;
}

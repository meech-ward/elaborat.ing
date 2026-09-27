/**
 * Names for new files and folders, as the explorer's name field proposes and
 * checks them. Pure: the store checks again when the file is created.
 */
import { basenameForPath, validateWorkspaceBasename, validateWorkspacePath, workspacePathSuffix } from "@/features/workspace";
import { companionPaths } from "@/features/project-storage/model";
import { folderNameError, joinFolder } from "./folderTree";
import { kindForPath } from "./session";

/** What the name field creates. */
export type NewEntryKind = "note" | "mdx" | "drawing" | "diagram" | "folder";

/** The kind's extension; a folder has none. */
export function newEntryExtension(kind: NewEntryKind): string {
  return kind === "note" ? ".md" : kind === "mdx" ? ".mdx" : kind === "drawing" ? ".excalidraw" : kind === "diagram" ? ".d2" : "";
}

/** How the field and its messages name the kind. */
export function newEntryNoun(kind: NewEntryKind): string {
  return kind === "mdx" ? "MDX note" : kind;
}

/**
 * The name the field starts with: "untitled" with the kind's extension, or
 * "untitled-2" and so on when that is taken in `dir`.
 */
export function proposedName(kind: NewEntryKind, dir: string, taken: readonly string[]): string {
  const used = new Set(taken.map((path) => path.toLowerCase()));
  const extension = newEntryExtension(kind);
  for (let n = 1; ; n++) {
    const name = `untitled${n === 1 ? "" : `-${n}`}${extension}`;
    if (!used.has(joinFolder(dir, name).toLowerCase())) return name;
  }
}

/**
 * Where a copy of `path` goes: "<name> copy" in the same folder, keeping the
 * extension, then "<name> copy 2" and so on past names taken there. A
 * diagram's generated files are copied with it, so their names must be free
 * too.
 */
export function duplicatePath(path: string, taken: readonly string[]): string {
  const used = new Set(taken.map((entry) => entry.toLowerCase()));
  const extension = path.slice(path.length - (workspacePathSuffix(path)?.length ?? 0));
  const stem = path.slice(0, path.length - extension.length);
  for (let n = 1; ; n++) {
    const copy = `${stem} copy${n === 1 ? "" : ` ${n}`}${extension}`;
    if ([copy, ...companionPaths(copy)].every((entry) => !used.has(entry.toLowerCase()))) return copy;
  }
}

/** How much of `name` to select at first: all of it but the kind's extension. */
export function nameStemLength(kind: NewEntryKind, name: string): number {
  const extension = newEntryExtension(kind);
  return extension && name.toLowerCase().endsWith(extension) && name.length > extension.length ? name.length - extension.length : name.length;
}

/**
 * The path a new file named `name` takes in `dir`, with the kind's extension
 * added when the name has none, or why the name can't be used: empty,
 * invalid, the wrong kind of file, or taken by a file or folder.
 */
export function newFilePath(
  kind: Exclude<NewEntryKind, "folder">,
  dir: string,
  name: string,
  taken: { files: readonly string[]; dirs: readonly string[] },
): { path: string } | { error: string } {
  if (name.trim() === "") return { error: "Enter a name." };
  if (name !== name.trim()) return { error: "Names cannot start or end with a space." };
  if (validateWorkspaceBasename(name) === null) {
    return { error: "Use one file name without separators, leading dots, or control characters." };
  }
  const extension = newEntryExtension(kind);
  const full = basenameForPath(name).includes(".") ? name : `${name}${extension}`;
  const path = joinFolder(dir, full);
  // The name keeps the kind's own extension, so the file opens as that kind
  // (a drawing is `.excalidraw`, never `.excalidraw.md`, which is a note-like wrapper).
  const wanted = kind === "mdx" ? "note" : kind;
  if (validateWorkspacePath(path) !== path || !path.toLowerCase().endsWith(extension) || kindForPath(path) !== wanted) {
    return { error: `${kind === "mdx" ? "An" : "A"} ${newEntryNoun(kind)}'s name ends with ${extension}.` };
  }
  const lower = path.toLowerCase();
  if (taken.files.some((file) => file.toLowerCase() === lower) || taken.dirs.some((folder) => folder.toLowerCase() === lower)) {
    return { error: `${full} already exists here. Choose another name.` };
  }
  return { path };
}

/** Why `name` can't be a new folder in `dir`, or null. */
export function newFolderError(dir: string, name: string, taken: { files: readonly string[]; dirs: readonly string[] }): string | null {
  return folderNameError(dir, name, taken.dirs, taken.files);
}

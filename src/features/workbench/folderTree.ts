/**
 * Folder tree rules (pure logic).
 *
 * Builds the explorer's nested folder model from one authoritative stored
 * listing plus open unsaved drafts. No React, no storage, no network: the
 * workbench owns fetching, persistence, and rendering.
 *
 * Identity rule: directory and file paths are raw canonical workspace
 * identities. Nothing here decodes `%`-sequences — decoding would merge
 * distinct names (a literal `100%25.md` is not `100%.md`). Validation is
 * purely syntactic and never rewrites the identity it checks.
 */
import {
  basenameForPath,
  validateWorkspaceBasename,
} from "@/features/workspace";

export interface TreeFile {
  /** Full canonical workspace path (copy/action/accessibility identity). */
  path: string;
  /** True for an open unsaved tab that is not a saved file. */
  draft: boolean;
}

export interface FolderNode {
  /** Full canonical directory path, e.g. `documents/customer-model`. */
  path: string;
  /** Basename label, e.g. `customer-model`. */
  name: string;
  /** Child folders, folders-first sorted (see compareNames). */
  folders: FolderNode[];
  /** Files directly in this folder, sorted (see compareNames). */
  files: TreeFile[];
}

export interface FolderTree {
  folders: FolderNode[];
  /** Saved and draft files directly at the project root, sorted. */
  rootFiles: TreeFile[];
}

/** Deterministic code-unit ordering (stable across browsers/locales). */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The paths the tree shows: a D2 diagram's generated files (`x.excalidraw`
 * and `x.d2.json` beside `x.d2`) are left out, since they belong to the
 * diagram. A drawing without a diagram of the same name stays.
 */
export function hideGeneratedFiles(paths: readonly string[]): string[] {
  const diagrams = new Set(paths.filter((path) => path.endsWith(".d2")));
  return paths.filter((path) => {
    if (path.endsWith(".d2.json")) return !diagrams.has(path.slice(0, -".json".length));
    if (path.endsWith(".excalidraw")) return !diagrams.has(`${path.slice(0, -".excalidraw".length)}.d2`);
    return true;
  });
}

/** Parent directory of a file or folder path; "" is the workspace root. */
export function parentDirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Ancestor directories of a file or folder path, shallowest first.
 * `ancestorsOf("a/b/note.md")` is `["a", "a/b"]`; root children have none.
 */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let parent = parentDirOf(path);
  while (parent !== "") {
    out.unshift(parent);
    parent = parentDirOf(parent);
  }
  return out;
}

/**
 * Syntactic canonical-directory check. Accepts the same segment policy as
 * file paths (no traversal, dotfiles, empty segments, or controls) without
 * requiring a file extension, and never decodes the identity. "" (root) is
 * not a directory path; it is handled explicitly by callers.
 */
export function isCanonicalDirectoryPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 512)
    return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    // Basename policy only — never decoded, so literal `%` names keep
    // their exact identity instead of merging with another directory.
    if (validateWorkspaceBasename(segment) === null) return false;
  }
  return true;
}

/** Join a folder and child basename; "" selects the workspace root. */
export function joinFolder(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * Build the nested tree. `directories` are the project's explicit stored
 * folders (root excluded, empty folders included);
 * `filePaths` are canonical saved file paths; `draftPaths` are open
 * unsaved tabs that must appear without posing as saved files. Implied
 * ancestors of files and drafts are shown so every file has a visible
 * chain even when the listing omits redundant parents. Folders sort before
 * files at every level; siblings sort by basename deterministically.
 */
export function buildFolderTree(
  filePaths: readonly string[],
  directories: readonly string[],
  draftPaths: readonly string[] = [],
): FolderTree {
  const nodes = new Map<string, FolderNode>();
  const nodeFor = (path: string): FolderNode => {
    let node = nodes.get(path);
    if (!node) {
      node = {
        path,
        name: basenameForPath(path),
        folders: [],
        files: [],
      };
      nodes.set(path, node);
    }
    return node;
  };
  const ensureChain = (path: string): void => {
    for (const ancestor of ancestorsOf(path)) nodeFor(ancestor);
  };
  for (const dir of directories) {
    if (!isCanonicalDirectoryPath(dir)) continue;
    ensureChain(dir);
    nodeFor(dir);
  }
  const seenFiles = new Set<string>();
  const addFile = (path: string, draft: boolean): void => {
    if (seenFiles.has(path)) return;
    seenFiles.add(path);
    ensureChain(path);
    const parent = parentDirOf(path);
    if (parent === "") return; // collected into rootFiles below
    nodeFor(parent).files.push({ path, draft });
  };
  for (const path of filePaths) addFile(path, false);
  for (const path of draftPaths) {
    if (seenFiles.has(path)) continue; // a saved file wins over its draft echo
    addFile(path, true);
  }
  // Link children to parents and sort every level deterministically.
  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentDirOf(node.path);
    if (parent === "") roots.push(node);
    else nodeFor(parent).folders.push(node);
  }
  const sortNode = (node: FolderNode): void => {
    node.folders.sort((a, b) => compareNames(a.name, b.name));
    node.files.sort((a, b) =>
      compareNames(basenameForPath(a.path), basenameForPath(b.path)),
    );
    for (const child of node.folders) sortNode(child);
  };
  roots.sort((a, b) => compareNames(a.name, b.name));
  for (const root of roots) sortNode(root);
  const saved = new Set(filePaths);
  const rootFiles: TreeFile[] = [];
  for (const path of seenFiles) {
    if (parentDirOf(path) !== "") continue;
    rootFiles.push({ path, draft: !saved.has(path) });
  }
  rootFiles.sort((a, b) =>
    compareNames(basenameForPath(a.path), basenameForPath(b.path)),
  );
  return { folders: roots, rootFiles };
}

/**
 * Inline New Folder validation. Returns null when `name` yields exactly
 * one new child of `parent` ("" is the workspace root), else a user-facing
 * reason. Refuses unsafe names and collisions with existing directories
 * and saved files without touching the network; the save re-checks.
 */
export function folderNameError(
  parent: string,
  name: string,
  existingDirs: readonly string[],
  filePaths: readonly string[],
): string | null {
  if (name.trim() === "") return "Enter a folder name.";
  if (name !== name.trim())
    return "Folder names cannot start or end with a space.";
  if (validateWorkspaceBasename(name) === null) {
    return "Use one folder name without separators, leading dots, or control characters.";
  }
  if (parent !== "" && !isCanonicalDirectoryPath(parent)) {
    return "The selected folder is no longer available. Choose another destination.";
  }
  const candidate = joinFolder(parent, name);
  if (!isCanonicalDirectoryPath(candidate)) {
    return "That name cannot be a workspace folder here.";
  }
  const dirs = new Set(existingDirs);
  const files = new Set(filePaths);
  if (dirs.has(candidate) || files.has(candidate)) {
    return `"${name}" already exists here. Choose another name.`;
  }
  return null;
}

/**
 * Inline folder rename validation: null when `name` is a usable new name for
 * the folder at `path` in its current parent, else a user-facing reason. A
 * name that is already taken is refused when the move is planned.
 */
export function folderRenameError(path: string, name: string): string | null {
  if (name.trim() === "") return "Enter a folder name.";
  if (name !== name.trim()) return "Folder names cannot start or end with a space.";
  if (validateWorkspaceBasename(name) === null) {
    return "Use one folder name without separators, leading dots, or control characters.";
  }
  const candidate = joinFolder(parentDirOf(path), name);
  if (candidate === path) return "That is the current name; nothing to rename.";
  if (!isCanonicalDirectoryPath(candidate)) return "That name cannot be a workspace folder here.";
  return null;
}

/**
 * Expand the ancestor chain of `filePath` (reveal on open/restore).
 * Returns the merged expanded list, bounded and deduplicated; callers
 * decide when to apply it so a user-collapsed folder is not reopened.
 * The current ancestors win within the cap: when the merged list would
 * overflow, the latest unrelated entries are dropped deterministically
 * (earliest kept, matching preference sanitizing). A chain longer than
 * the cap keeps its shallowest prefix so the file stays reachable.
 */
export function revealAncestors(
  expanded: readonly string[],
  filePath: string,
  limit = 64,
): string[] {
  const cap = Math.max(0, limit);
  const ancestors = ancestorsOf(filePath).slice(0, cap);
  const merged = [...new Set([...expanded, ...ancestors])];
  if (merged.length <= cap) return merged;
  const ancestorSet = new Set(ancestors);
  const keepUnrelated = new Set(
    merged.filter((path) => !ancestorSet.has(path)).slice(0, cap - ancestors.length),
  );
  return merged.filter(
    (path) => ancestorSet.has(path) || keepUnrelated.has(path),
  );
}

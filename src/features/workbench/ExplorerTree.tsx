/**
 * Folder explorer tree.
 *
 * Semantic nested lists with disclosure buttons — deliberately not an ARIA
 * tree, whose complete keyboard contract is out of scope. Each folder row
 * (ExplorerFolderRow) carries ordinary buttons: a chevron that
 * expands/collapses, a name button that selects the creation destination
 * without touching the active editor, and Rename, Move to folder and
 * Delete. The explicit Workspace root row selects the root. Files reuse
 * ExplorerFileRow's right-click/Shift+F10/copy/rename behaviors with
 * basename labels; full paths stay in titles and accessible names.
 */
import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { basenameForPath } from "@/features/workspace";
import { ExplorerFileRow } from "./ExplorerFileRow";
import { ExplorerFolderRow } from "./ExplorerFolderRow";
import type { FolderNode, FolderTree, TreeFile } from "./folderTree";
import { canMove } from "./movePlan";

export interface ExplorerTreeProps {
  tree: FolderTree;
  /** Canonical expanded directory paths. */
  expanded: readonly string[];
  /** "" selects the workspace root; null is no explicit selection. */
  selectedFolder: string | null;
  activeFile: string | null;
  isDirty: (path: string) => boolean;
  isUnsavedDraft: (path: string) => boolean;
  /** The file has no saved copy: renaming it only changes the name it will be saved under. */
  isNeverSaved?: (path: string) => boolean;
  onToggleFolder: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  onFeedback: (message: string) => void;
  /** Rename and move arrive with roadmap phase 2 step 12; without them the row offers neither. */
  onRenameFile?: (path: string, newName: string) => Promise<void>;
  onMoveFile?: (path: string) => void;
  /** A folder moves with everything in it; without these its row offers neither. */
  onRenameFolder?: (path: string, newName: string) => Promise<void>;
  onMoveFolder?: (path: string) => void;
  /** Open the delete confirmation. Unsaved drafts that are not files yet offer no delete. */
  onDeleteFile?: (path: string) => void;
  onDeleteFolder?: (path: string) => void;
  /** A new file or folder's name field, shown first in the folder it goes in ("" is the root). */
  newEntry?: { dir: string; field: ReactNode } | null;
}

export function ExplorerTree({
  tree,
  expanded,
  selectedFolder,
  activeFile,
  isDirty,
  isUnsavedDraft,
  isNeverSaved = () => false,
  onToggleFolder,
  onSelectFolder,
  onOpenFile,
  onFeedback,
  onRenameFile,
  onMoveFile,
  onRenameFolder,
  onMoveFolder,
  onDeleteFile,
  onDeleteFolder,
  newEntry = null,
}: ExplorerTreeProps) {
  const open = new Set(expanded);
  const fieldIn = (dir: string) => (newEntry?.dir === dir ? <li key="new-entry" className="wb-tree-new">{newEntry.field}</li> : null);
  const rootSelected = selectedFolder === "";
  const renderFile = (file: TreeFile) => (
    <li key={file.path} className="wb-tree-file">
      <ExplorerFileRow
        path={file.path}
        label={basenameForPath(file.path)}
        active={file.path === activeFile}
        dirty={isDirty(file.path)}
        unsavedDraft={isUnsavedDraft(file.path)}
        neverSaved={isNeverSaved(file.path)}
        draft={file.draft}
        onOpen={() => onOpenFile(file.path)}
        onFeedback={onFeedback}
        onRename={onRenameFile && canMove(file.path) ? (newName) => onRenameFile(file.path, newName) : undefined}
        onMove={onMoveFile && canMove(file.path) ? () => onMoveFile(file.path) : undefined}
        onDelete={onDeleteFile && !file.draft ? () => onDeleteFile(file.path) : undefined}
      />
    </li>
  );
  const renderFolder = (node: FolderNode) => {
    const isOpen = open.has(node.path);
    return (
      <li key={node.path} className="wb-tree-folder">
        <ExplorerFolderRow
          path={node.path}
          name={node.name}
          open={isOpen}
          selected={selectedFolder === node.path}
          onToggle={() => onToggleFolder(node.path)}
          onSelect={() => onSelectFolder(node.path)}
          onRename={onRenameFolder ? (newName) => onRenameFolder(node.path, newName) : undefined}
          onMove={onMoveFolder ? () => onMoveFolder(node.path) : undefined}
          onDelete={onDeleteFolder ? () => onDeleteFolder(node.path) : undefined}
        />
        {isOpen && (
          <ul className="wb-tree-nested">
            {fieldIn(node.path)}
            {node.folders.map(renderFolder)}
            {node.files.map(renderFile)}
          </ul>
        )}
      </li>
    );
  };
  return (
    <div className="wb-tree">
      <button
        className="wb-tree-root"
        aria-pressed={rootSelected}
        aria-label="Select Workspace root for creation"
        title="Workspace root"
        onClick={() => onSelectFolder("")}
      >
        <FolderOpen size={15} aria-hidden="true" />
        <span className="wb-tree-name">Workspace root</span>
      </button>
      <ul className="wb-tree-list">
        {fieldIn("")}
        {tree.folders.map(renderFolder)}
        {tree.rootFiles.map(renderFile)}
      </ul>
    </div>
  );
}

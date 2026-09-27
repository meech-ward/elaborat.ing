/**
 * Folder explorer tree: the library's tree rows in one SidebarMenu, each
 * indented by its depth. Deliberately not an ARIA tree, whose complete
 * keyboard contract is out of scope: a folder row is a disclosure button
 * (aria-expanded) that also makes the folder where new files and folders go,
 * and a file row opens the file. Rows carry Rename, Move to folder, Delete
 * and, for files, Copy and Duplicate, in a right-click menu and an action
 * menu button (ExplorerFolderRow, ExplorerFileRow). Rows show basenames;
 * full paths stay in titles and accessible names. The active file's row
 * scrolls into view once each time the active file changes (the workbench
 * expands its folders).
 */
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { SidebarMenu } from "@/components/ui/sidebar";
import type { PanelRowSize } from "@/features/design-system";
import { basenameForPath } from "@/features/workspace";
import { ExplorerFileRow } from "./ExplorerFileRow";
import { ExplorerFolderRow } from "./ExplorerFolderRow";
import type { FolderNode, FolderTree, TreeFile } from "./folderTree";
import { canMove } from "./movePlan";

export interface ExplorerTreeProps {
  tree: FolderTree;
  /** `touch` on the phone's files screen. */
  size?: PanelRowSize;
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
  /** Without these a row offers no rename or move. */
  onRenameFile?: (path: string, newName: string) => Promise<void>;
  onMoveFile?: (path: string) => void;
  /** Copy a file next to itself; read-only projects offer no Duplicate. */
  onDuplicateFile?: (path: string) => void;
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
  size = "default",
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
  onDuplicateFile,
  onRenameFolder,
  onMoveFolder,
  onDeleteFile,
  onDeleteFolder,
  newEntry = null,
}: ExplorerTreeProps) {
  const root = useRef<HTMLUListElement>(null);
  // The file whose row was last scrolled to, so scrolling the tree by hand is left alone.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFile || shown.current === activeFile) return;
    const row = root.current?.querySelector('[data-tree-row="file"] > [data-active]');
    // Not there yet (a folder above it is still closed) or not shown: try again later.
    if (!row || row.getClientRects().length === 0) return;
    shown.current = activeFile;
    row.scrollIntoView({ block: "nearest" });
  }, [activeFile, expanded]);
  const open = new Set(expanded);
  const fieldIn = (dir: string) => (newEntry?.dir === dir ? newEntry.field : null);
  const renderFile = (file: TreeFile, depth: number) => (
    <ExplorerFileRow
      key={file.path}
      path={file.path}
      label={basenameForPath(file.path)}
      depth={depth}
      size={size}
      active={file.path === activeFile}
      dirty={isDirty(file.path)}
      unsavedDraft={isUnsavedDraft(file.path)}
      neverSaved={isNeverSaved(file.path)}
      draft={file.draft}
      onOpen={() => onOpenFile(file.path)}
      onFeedback={onFeedback}
      onRename={onRenameFile && canMove(file.path) ? (newName) => onRenameFile(file.path, newName) : undefined}
      onDuplicate={onDuplicateFile ? () => onDuplicateFile(file.path) : undefined}
      onMove={onMoveFile && canMove(file.path) ? () => onMoveFile(file.path) : undefined}
      onDelete={onDeleteFile && !file.draft ? () => onDeleteFile(file.path) : undefined}
    />
  );
  const renderFolder = (node: FolderNode, depth: number): ReactNode => {
    const isOpen = open.has(node.path);
    return (
      <Fragment key={node.path}>
        <ExplorerFolderRow
          path={node.path}
          name={node.name}
          depth={depth}
          size={size}
          open={isOpen}
          selected={selectedFolder === node.path}
          onToggle={() => onToggleFolder(node.path)}
          onSelect={() => onSelectFolder(node.path)}
          onRename={onRenameFolder ? (newName) => onRenameFolder(node.path, newName) : undefined}
          onMove={onMoveFolder ? () => onMoveFolder(node.path) : undefined}
          onDelete={onDeleteFolder ? () => onDeleteFolder(node.path) : undefined}
        />
        {isOpen && (
          <>
            {fieldIn(node.path)}
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.files.map((file) => renderFile(file, depth + 1))}
          </>
        )}
      </Fragment>
    );
  };
  return (
    <SidebarMenu ref={root}>
      {fieldIn("")}
      {tree.folders.map((folder) => renderFolder(folder, 0))}
      {tree.rootFiles.map((file) => renderFile(file, 0))}
    </SidebarMenu>
  );
}

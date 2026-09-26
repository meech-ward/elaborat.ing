/**
 * Folder explorer tree.
 *
 * Semantic nested lists with disclosure buttons — deliberately not an ARIA
 * tree, whose complete keyboard contract is out of scope. Each folder row
 * carries two ordinary buttons: a chevron that expands/collapses and a
 * name button that selects the creation destination without touching the
 * active editor. The explicit Workspace root row selects the root. Files
 * reuse ExplorerFileRow's right-click/Shift+F10/copy/rename behaviors with
 * basename labels; full paths stay in titles and accessible names.
 */
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { basenameForPath } from "@/features/workspace";
import { ExplorerFileRow } from "./ExplorerFileRow";
import type { FolderNode, FolderTree, TreeFile } from "./folderTree";

export interface ExplorerTreeProps {
  tree: FolderTree;
  /** Canonical expanded directory paths. */
  expanded: readonly string[];
  /** "" selects the workspace root; null is no explicit selection. */
  selectedFolder: string | null;
  activeFile: string | null;
  isDirty: (path: string) => boolean;
  isUnsavedDraft: (path: string) => boolean;
  onToggleFolder: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  onFeedback: (message: string) => void;
  onRenameFile: (path: string, newName: string) => Promise<void>;
  onMoveFile: (path: string) => void;
}

export function ExplorerTree({
  tree,
  expanded,
  selectedFolder,
  activeFile,
  isDirty,
  isUnsavedDraft,
  onToggleFolder,
  onSelectFolder,
  onOpenFile,
  onFeedback,
  onRenameFile,
  onMoveFile,
}: ExplorerTreeProps) {
  const open = new Set(expanded);
  const rootSelected = selectedFolder === "";
  const renderFile = (file: TreeFile) => (
    <li key={file.path} className="wb-tree-file">
      <ExplorerFileRow
        path={file.path}
        label={basenameForPath(file.path)}
        active={file.path === activeFile}
        dirty={isDirty(file.path)}
        unsavedDraft={isUnsavedDraft(file.path)}
        draft={file.draft}
        onOpen={() => onOpenFile(file.path)}
        onFeedback={onFeedback}
        onRename={(newName) => onRenameFile(file.path, newName)}
        onMove={() => onMoveFile(file.path)}
      />
    </li>
  );
  const renderFolder = (node: FolderNode) => {
    const isOpen = open.has(node.path);
    const selected = selectedFolder === node.path;
    const Icon = isOpen ? FolderOpen : Folder;
    return (
      <li key={node.path} className="wb-tree-folder">
        <div className="wb-tree-row" data-selected={selected}>
          <button
            className="wb-tree-select"
            aria-pressed={selected}
            aria-label={`Select folder ${node.path} for creation`}
            title={node.path}
            onClick={() => onSelectFolder(node.path)}
          >
            <Icon size={15} aria-hidden="true" />
            <span className="wb-tree-name">{node.name}</span>
          </button>
          <button
            className="wb-tree-toggle"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.path}`}
            title={`${isOpen ? "Collapse" : "Expand"} ${node.path}`}
            onClick={() => onToggleFolder(node.path)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        {isOpen && (
          <ul className="wb-tree-nested">
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
        {tree.folders.map(renderFolder)}
        {tree.rootFiles.map(renderFile)}
      </ul>
    </div>
  );
}

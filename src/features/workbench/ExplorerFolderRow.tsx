/**
 * Explorer folder row: a name button that selects the folder as the
 * creation destination, a chevron that expands or collapses it, and, as for
 * files, Rename, Move to folder and Delete through a Base UI context menu
 * (right-click, keyboard Menu/Shift+F10, long-press) plus an action-menu
 * button with the same list. Renaming uses the files' rename dialog; the
 * workbench moves or deletes the folder with everything in it and reports
 * the result.
 */
import { useState } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  MenuItems,
  type MenuEntry,
} from "@/components/ui/menu";
import { ActionMenu } from "./WorkbenchChrome";
import { openRowMenuFromKeyboard } from "./explorerActions";
import { folderRenameError } from "./folderTree";
import { RenameDialog } from "./RenameDialog";

export function ExplorerFolderRow({
  path,
  name,
  open,
  selected,
  onToggle,
  onSelect,
  onRename,
  onMove,
  onDelete,
}: {
  path: string;
  /** The folder's own name, shown on the row. */
  name: string;
  /** Expanded in the tree. */
  open: boolean;
  /** Selected as the creation destination. */
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  /** Validated new name; resolves when the rename settles. Without it the row offers no rename. */
  onRename?: (name: string) => Promise<void>;
  onMove?: () => void;
  /** Opens the delete confirmation for the folder and everything in it. */
  onDelete?: () => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  // A new dialog for each opening, so it starts from the current name.
  const [renameKey, setRenameKey] = useState(0);
  const Icon = open ? FolderOpen : Folder;
  const hasActions = Boolean(onRename || onMove || onDelete);
  const requestRename = () => {
    setRenameKey((key) => key + 1);
    setRenameOpen(true);
  };
  // One list for the action button and the right-click menu.
  const items: MenuEntry[] = [
    ...(onRename ? [{ label: "Rename", onSelect: requestRename }] : []),
    ...(onMove ? [{ label: "Move to folder", onSelect: onMove }] : []),
    ...(onDelete ? [{ label: "Delete", onSelect: onDelete, destructive: true }] : []),
  ];

  const buttons = (
    <>
      <button
        className="wb-tree-select"
        aria-pressed={selected}
        aria-label={`Select folder ${path} for creation`}
        title={path}
        onClick={onSelect}
        onKeyDown={hasActions ? openRowMenuFromKeyboard : undefined}
      >
        <Icon size={15} aria-hidden="true" />
        <span className="wb-tree-name">{name}</span>
      </button>
      {hasActions && <ActionMenu label={`Actions for folder ${path}`} items={items} />}
      <button
        className="wb-tree-toggle"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${path}`}
        title={`${open ? "Collapse" : "Expand"} ${path}`}
        onClick={onToggle}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </>
  );

  if (!hasActions) {
    return (
      <div className="wb-tree-row" data-selected={selected}>
        {buttons}
      </div>
    );
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger className="wb-tree-row" data-selected={selected}>
          {buttons}
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for folder ${path}`}>
          <MenuItems items={items} />
        </ContextMenuContent>
      </ContextMenu>
      {onRename && (
        <RenameDialog
          key={renameKey}
          open={renameOpen}
          title={`Rename folder ${path}`}
          description="Choose a new name for the folder. Everything in it moves with it, and references to its files are updated in the same save."
          label="New folder name"
          initial={name}
          selectLength={name.length}
          validate={(next) => folderRenameError(path, next)}
          onRename={onRename}
          onOpenChange={setRenameOpen}
        />
      )}
    </>
  );
}

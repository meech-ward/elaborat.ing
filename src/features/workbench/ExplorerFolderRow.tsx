/**
 * Explorer folder row: the library's TreeFolderRow. Choosing the row opens
 * or closes the folder and makes it where new files and folders go. As for
 * files, Rename, Move to folder and Delete are in a right-click menu
 * (keyboard Menu/Shift+F10, long-press) on the row and in its action menu
 * button. Renaming uses the files' rename dialog; the workbench moves or
 * deletes the folder with everything in it and reports the result.
 */
import { useState } from "react";
import { TreeFolderRow, TreeRowMenu, type MenuEntry, type PanelRowSize } from "@/features/design-system";
import { openRowMenuFromKeyboard } from "./explorerActions";
import { folderRenameError } from "./folderTree";
import { RenameDialog } from "./RenameDialog";

export function ExplorerFolderRow({
  path,
  name,
  depth = 0,
  size = "default",
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
  /** How deep the row sits in the tree: 0 at the top of the project. */
  depth?: number;
  /** `touch` on the phone's files screen. */
  size?: PanelRowSize;
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
  const hasActions = items.length > 0;
  const menuLabel = `Actions for folder ${path}`;

  return (
    <>
      <TreeFolderRow
        name={name}
        open={open}
        depth={depth}
        size={size}
        selected={selected}
        title={path}
        data-path={path}
        aria-label={name !== path ? path : undefined}
        onClick={() => {
          onSelect();
          onToggle();
        }}
        onKeyDown={hasActions ? openRowMenuFromKeyboard : undefined}
        rowMenu={hasActions ? { label: menuLabel, entries: items } : undefined}
        actions={hasActions ? <TreeRowMenu label={menuLabel} entries={items} size={size} /> : undefined}
      />
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

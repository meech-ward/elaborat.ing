/**
 * Explorer file row: the library's TreeFileRow, with the same actions in a
 * right-click menu (keyboard Menu/Shift+F10, long-press) on the row and in
 * its action menu button, which shows on hover and focus, and always on
 * touch screens; hidden, it stays in the accessibility tree.
 *
 * The actions are Copy filename, Copy path, Rename, Duplicate, Move to
 * folder and Delete. Requesting the menu never opens the file: opening
 * happens only through the row itself. Rename runs through a dialog with
 * inline validation; the workbench performs the rename and reports the
 * result. The dialog stays open (pending, non-dismissable) until the rename
 * settles, so the renamed session is inert while the request runs and typing
 * cannot create a newly dirty draft under async completion.
 */
import { useState } from "react";
import { TreeFileRow, TreeRowMenu, type MenuEntry, type PanelRowSize } from "@/features/design-system";
import { embedded } from "@/features/embed/mode";
import {
  copyPayloadForPath,
  copyTextToClipboard,
  openRowMenuFromKeyboard,
  renameNameError,
  renameStemLength,
} from "./explorerActions";
import { RenameDialog } from "./RenameDialog";
import { kindForPath } from "./session";
import { duplicateShortcutLabel } from "./viewShortcuts";

export function ExplorerFileRow({
  path,
  label,
  depth = 0,
  size = "default",
  active,
  dirty,
  unsavedDraft,
  neverSaved = false,
  draft,
  onOpen,
  onFeedback,
  onRename,
  onDuplicate,
  onMove,
  onDelete,
}: {
  path: string;
  /**
   * Visible row label (the folder tree passes the basename). Full-path
   * identity is always preserved in the title, accessible name, and
   * copy/rename actions; defaults to the full path.
   */
  label?: string;
  /** How deep the row sits in the tree: 0 at the top of the project. */
  depth?: number;
  /** `touch` on the phone's files screen. */
  size?: PanelRowSize;
  active: boolean;
  /** True when the file is open with unsaved changes (rename refused). */
  dirty: boolean;
  /** True when the file is open as a never-saved draft (rename refused, unless `neverSaved`). */
  unsavedDraft: boolean;
  /** The file has no saved copy at all: a rename moves its draft, unsaved edits included. */
  neverSaved?: boolean;
  /** True for an open unsaved tab shown in the tree before its first save. */
  draft?: boolean;
  onOpen: () => void;
  /** Visible feedback for copy results and rename refusals. */
  onFeedback: (message: string) => void;
  /**
   * Validated new basename; the workbench runs the rename. Resolves
   * when the rename (and tab reopen) settles; the dialog stays pending
   * until then and closes on completion.
   */
  onRename?: (newName: string) => Promise<void>;
  /** Copies the file next to itself and opens the copy; the workbench reports the result. */
  onDuplicate?: () => void;
  onMove?: () => void;
  /** Opens the delete confirmation; the workbench deletes and reports the result. */
  onDelete?: () => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  // A new dialog for each opening, so it starts from the current name.
  const [renameKey, setRenameKey] = useState(0);

  const copy = async (text: string, what: string) => {
    try {
      await copyTextToClipboard(text);
      onFeedback(`Copied ${what} "${text}".`);
    } catch (copyError) {
      onFeedback(`Copy failed: ${copyError instanceof Error ? copyError.message : String(copyError)}.`);
    }
  };
  const requestRename = () => {
    if (neverSaved) {
      setRenameKey((key) => key + 1);
      setRenameOpen(true);
      return;
    }
    if (dirty) {
      onFeedback(`Rename refused: ${path} has unsaved changes. Save or discard them first, then rename again.`);
      return;
    }
    if (unsavedDraft) {
      onFeedback(
        `Rename refused: ${path} is open as an unsaved draft that has never been saved. Save it first, then rename again.`,
      );
      return;
    }
    setRenameKey((key) => key + 1);
    setRenameOpen(true);
  };

  // One list for the action button and the right-click menu.
  // A chat's panel has no clipboard, so it has no Copy entries.
  const items: MenuEntry[] = [
    ...(embedded
      ? []
      : [
          { label: "Copy filename", onSelect: () => void copy(copyPayloadForPath(path).filename, "filename") },
          { label: "Copy path", onSelect: () => void copy(path, "path") },
        ]),
    ...(onRename ? [{ label: "Rename", onSelect: requestRename }] : []),
    ...(onDuplicate ? [{ label: "Duplicate", onSelect: onDuplicate, shortcut: duplicateShortcutLabel() }] : []),
    ...(onMove ? [{ label: "Move to folder", onSelect: onMove }] : []),
    ...(onDelete ? [{ label: "Delete", onSelect: onDelete, destructive: true }] : []),
  ];
  const menuLabel = `Actions for ${path}`;

  return (
    <>
      <TreeFileRow
        name={label ?? path}
        kind={kindForPath(path)}
        depth={depth}
        size={size}
        selected={active}
        dirty={dirty || Boolean(draft)}
        title={path}
        data-path={path}
        aria-label={draft ? `${path}, unsaved draft` : label && label !== path ? path : undefined}
        onClick={onOpen}
        onKeyDown={openRowMenuFromKeyboard}
        rowMenu={items.length > 0 ? { label: menuLabel, entries: items } : undefined}
        actions={items.length > 0 ? <TreeRowMenu label={menuLabel} entries={items} size={size} /> : undefined}
      />
      <RenameDialog
        key={renameKey}
        open={renameOpen}
        title={`Rename in ${dirOf(path)}`}
        description="Choose a new file name in the same folder. The extension stays the same."
        label="New file name"
        initial={copyPayloadForPath(path).filename}
        selectLength={renameStemLength(path)}
        validate={(name) => renameNameError(path, name)}
        onRename={(name) => onRename?.(name) ?? Promise.resolve()}
        onOpenChange={setRenameOpen}
      />
    </>
  );
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "the workspace root" : path.slice(0, slash);
}

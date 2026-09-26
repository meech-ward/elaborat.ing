/**
 * Explorer file row with shadcn/Base UI context-menu actions.
 *
 * Each row exposes Rename, Copy filename, and Copy path through a real
 * Base UI context menu (right-click, keyboard Menu/Shift+F10, long-press)
 * on the whole row, plus an always-visible action-menu button carrying
 * the same three actions for touch and assistive-technology users.
 * Requesting the menu never opens the file: opening happens only through
 * the row's primary button. Rename runs through a dialog with inline
 * validation; the workbench performs the rename and reports the
 * result. The dialog stays open (pending, non-dismissable) until the
 * rename settles, so the renamed session is inert while the request runs
 * and typing cannot create a newly dirty draft under async completion.
 */
import { useState } from "react";
import { Copy, Link, Pencil, FolderInput } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { ActionMenu } from "./WorkbenchChrome";
import {
  copyPayloadForPath,
  copyTextToClipboard,
  openRowMenuFromKeyboard,
  renameNameError,
  renameStemLength,
} from "./explorerActions";
import { RenameDialog } from "./RenameDialog";

export function ExplorerFileRow({
  path,
  label,
  active,
  dirty,
  unsavedDraft,
  draft,
  onOpen,
  onFeedback,
  onRename,
  onMove,
}: {
  path: string;
  /**
   * Visible row label (the folder tree passes the basename). Full-path
   * identity is always preserved in the title, accessible name, and
   * copy/rename actions; defaults to the full path.
   */
  label?: string;
  active: boolean;
  /** True when the file is open with unsaved changes (rename refused). */
  dirty: boolean;
  /** True when the file is open as a never-saved draft (rename refused). */
  unsavedDraft: boolean;
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
  onMove?: () => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  // A new dialog for each opening, so it starts from the current name.
  const [renameKey, setRenameKey] = useState(0);

  const copyFilename = async () => {
    const { filename } = copyPayloadForPath(path);
    try {
      await copyTextToClipboard(filename);
      onFeedback(`Copied filename "${filename}".`);
    } catch (copyError) {
      onFeedback(
        `Copy failed: ${copyError instanceof Error ? copyError.message : String(copyError)}.`,
      );
    }
  };
  const copyPath = async () => {
    try {
      await copyTextToClipboard(path);
      onFeedback(`Copied path "${path}".`);
    } catch (copyError) {
      onFeedback(
        `Copy failed: ${copyError instanceof Error ? copyError.message : String(copyError)}.`,
      );
    }
  };
  const requestRename = () => {
    if (dirty) {
      onFeedback(
        `Rename refused: ${path} has unsaved changes. Save or discard them first, then rename again.`,
      );
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

  return (
    <div className="wb-explorer-row" data-active={active}>
      <ContextMenu>
        <ContextMenuTrigger className="wb-explorer-trigger">
          <button
            className="wb-explorer-open"
            aria-current={active}
            aria-label={
              draft
                ? `${path}, unsaved draft`
                : label && label !== path
                  ? path
                  : undefined
            }
            title={path}
            onClick={onOpen}
            onKeyDown={openRowMenuFromKeyboard}
          >
            {label ?? path}
            {draft && (
              <span aria-hidden="true" className="wb-explorer-draft">
                {" "}
                ●
              </span>
            )}
          </button>
          {/* Visible fallback for users who cannot open a context menu: the
          same three actions through an ordinary dropdown button. */}
          <ActionMenu label={`Actions for ${path}`}>
            <button onClick={() => void copyFilename()}>
              <Copy size={14} /> Copy filename
            </button>
            <button onClick={() => void copyPath()}>
              <Link size={14} /> Copy path
            </button>
            {onRename && (
              <button onClick={requestRename}>
                <Pencil size={14} /> Rename
              </button>
            )}
            {onMove && <button onClick={onMove}><FolderInput size={14} /> Move to folder</button>}
          </ActionMenu>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for ${path}`}>
          <ContextMenuItem onClick={() => void copyFilename()}>
            <Copy size={14} /> Copy filename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copyPath()}>
            <Link size={14} /> Copy path
          </ContextMenuItem>
          {onRename && (
            <ContextMenuItem onClick={requestRename}>
              <Pencil size={14} /> Rename
            </ContextMenuItem>
          )}
          {onMove && <ContextMenuItem onClick={onMove}><FolderInput size={14} /> Move to folder</ContextMenuItem>}
        </ContextMenuContent>
      </ContextMenu>
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
    </div>
  );
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "the workspace root" : path.slice(0, slash);
}

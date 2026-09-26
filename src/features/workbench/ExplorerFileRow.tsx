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
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
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
  renameNameError,
  renameStemLength,
} from "./explorerActions";

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
  const [renameDraft, setRenameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (renaming) return;
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
    setRenameDraft(copyPayloadForPath(path).filename);
    setError(null);
    setRenameOpen(true);
  };

  // Preselect the editable stem (basename minus extension) when the dialog opens.
  useEffect(() => {
    if (!renameOpen) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    try {
      input.setSelectionRange(0, renameStemLength(path));
    } catch {
      input.select();
    }
  }, [renameOpen, path]);

  const submitRename = () => {
    if (renaming) return;
    const problem = renameNameError(path, renameDraft);
    if (problem) {
      setError(problem);
      return;
    }
    // Keep the modal dialog open until the workbench settles: dismissing
    // here would let the user type a newly dirty draft while the request
    // runs, which async completion could then discard or mis-relabel.
    setRenaming(true);
    setError(null);
    const done = () => {
      setRenaming(false);
      setRenameOpen(false);
    };
    void onRename?.(renameDraft).then(done, done);
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
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              // Base UI handles contextmenu/touch, but Firefox does not
              // consistently synthesize contextmenu from keyboard input.
              // Route this real key through the same primitive and anchor.
              const bounds = event.currentTarget.getBoundingClientRect();
              event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + Math.min(24, bounds.width / 2),
                clientY: bounds.top + Math.min(24, bounds.height / 2),
                button: 2,
              }));
            }}
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
      <Dialog.Root
        open={renameOpen}
        onOpenChange={(next) => {
          // While the rename is in flight the dialog is not dismissable
          // (Escape, backdrop): closing it would re-enable typing in the
          // renamed session mid-request. Cancellation stays available
          // before submit via Cancel.
          if (!renaming) setRenameOpen(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="wb-backdrop" />
          <Dialog.Popup className="wb-palette wb-rename" aria-busy={renaming}>
            <Dialog.Title className="wb-rename-title">
              Rename in {dirOf(path)}
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              Choose a new file name in the same folder. The extension stays the same.
            </Dialog.Description>
            <label htmlFor={inputId}>New file name</label>
            <input
              id={inputId}
              ref={inputRef}
              value={renameDraft}
              disabled={renaming}
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value;
                setRenameDraft(next);
                if (error && !renameNameError(path, next)) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitRename();
                }
              }}
            />
            {error && (
              <p id={errorId} role="alert" className="wb-rename-error">
                {error}
              </p>
            )}
            {renaming && (
              <p role="status" className="wb-rename-pending">
                Renaming…
              </p>
            )}
            <div className="wb-rename-actions">
              {renaming ? (
                <button className="wb-rename-cancel" disabled>
                  Cancel
                </button>
              ) : (
                <Dialog.Close className="wb-rename-cancel">Cancel</Dialog.Close>
              )}
              <button onClick={submitRename} disabled={renaming}>
                {renaming ? "Renaming…" : "Rename"}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "the workspace root" : path.slice(0, slash);
}

/**
 * New Folder dialog.
 *
 * One named child of the selected existing directory (or the workspace
 * root) through the existing Base UI Dialog primitive. Inline validation
 * refuses unsafe names and existing targets before any save; a stored
 * refusal stays visible in the open dialog and changes no file. While the
 * request is pending the dialog is non-dismissable and the input inert,
 * mirroring the rename dialog's lifecycle.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { folderNameError } from "./folderTree";

export function CreateFolderDialog({
  open,
  parent,
  existingDirs,
  filePaths,
  pending,
  serverError,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  /** "" is the workspace root. */
  parent: string;
  existingDirs: readonly string[];
  filePaths: readonly string[];
  pending: boolean;
  /** Visible save refusal; the dialog stays open until dismissed. */
  serverError: string | null;
  onSubmit: (name: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || pending) return;
    inputRef.current?.focus();
  }, [open, pending]);

  const where = parent === "" ? "Workspace root" : parent;
  const submit = () => {
    if (pending) return;
    const problem = folderNameError(parent, draft, existingDirs, filePaths);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onSubmit(draft);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setDraft("");
          setError(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="wb-backdrop" />
        <Dialog.Popup className="wb-palette wb-rename" aria-busy={pending}>
          <Dialog.Title className="wb-rename-title">
            New folder in {where}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Choose a name for one new folder inside {where}. The folder is
            created empty in the project.
          </Dialog.Description>
          <label htmlFor={inputId}>Folder name</label>
          <input
            id={inputId}
            ref={inputRef}
            value={draft}
            disabled={pending}
            aria-invalid={error !== null || serverError !== null}
            aria-describedby={error || serverError ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              if (
                error &&
                !folderNameError(parent, next, existingDirs, filePaths)
              )
                setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
          {error && (
            <p id={errorId} role="alert" className="wb-rename-error">
              {error}
            </p>
          )}
          {!error && serverError && (
            <p id={errorId} role="alert" className="wb-rename-error">
              {serverError}
            </p>
          )}
          {pending && (
            <p role="status" className="wb-rename-pending">
              Creating…
            </p>
          )}
          <div className="wb-rename-actions">
            {pending ? (
              <button className="wb-rename-cancel" disabled>
                Cancel
              </button>
            ) : (
              <Dialog.Close className="wb-rename-cancel">Cancel</Dialog.Close>
            )}
            <button onClick={submit} disabled={pending}>
              {pending ? "Creating…" : "Create folder"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

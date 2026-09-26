/**
 * Rename dialog for explorer files and folders: one new name in the same
 * folder, validated inline before any save. The workbench performs the
 * rename and reports the result. The dialog stays open (pending,
 * non-dismissable) until the rename settles, so the renamed files are inert
 * while the request runs and typing cannot create a newly dirty draft under
 * async completion. Mount it with a new `key` for each opening, so it starts
 * from `initial`.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";

export function RenameDialog({
  open,
  title,
  description,
  label,
  initial,
  selectLength,
  validate,
  onRename,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  /** Read by screen readers only. */
  description: string;
  /** The name field's label, such as "New file name". */
  label: string;
  /** The current name. */
  initial: string;
  /** How much of the name to preselect (a file's name without its extension). */
  selectLength: number;
  /** A user-facing reason `name` cannot be used, or null. */
  validate: (name: string) => string | null;
  /** Runs the rename; the dialog closes once it settles. */
  onRename: (name: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // Preselect the editable part of the name when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    try {
      input.setSelectionRange(0, selectLength);
    } catch {
      input.select();
    }
  }, [open, selectLength]);

  const submit = () => {
    if (renaming) return;
    const problem = validate(draft);
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
      onOpenChange(false);
    };
    void onRename(draft).then(done, done);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // While the rename is in flight the dialog is not dismissable
        // (Escape, backdrop): closing it would re-enable typing in the
        // renamed session mid-request. Cancellation stays available
        // before submit via Cancel.
        if (!renaming) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="wb-backdrop" />
        <Dialog.Popup className="wb-palette wb-rename" aria-busy={renaming}>
          <Dialog.Title className="wb-rename-title">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          <label htmlFor={inputId}>{label}</label>
          <input
            id={inputId}
            ref={inputRef}
            value={draft}
            disabled={renaming}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              if (error && !validate(next)) setError(null);
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
            <button onClick={submit} disabled={renaming}>
              {renaming ? "Renaming…" : "Rename"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

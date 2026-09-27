/**
 * Rename dialog for explorer files and folders: one new name in the same
 * folder, validated inline before any save. The workbench performs the
 * rename and reports the result. The dialog stays open (pending,
 * non-dismissable) until the rename settles, so the renamed files are inert
 * while the request runs and typing cannot create a newly dirty draft under
 * async completion; a refusal `onRename` throws shows in the dialog, which
 * stays open. On a phone it also names a new file or folder. Mount it with a
 * new `key` for each opening, so it starts from `initial`.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dialogError, dialogPending } from "./dialogMessages";

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
  submitLabel = "Rename",
  pendingLabel = "Renaming…",
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
  /** Runs the rename; the dialog closes once it succeeds. */
  onRename: (name: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  /** The submit button, such as "Create" when naming something new. */
  submitLabel?: string;
  pendingLabel?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // The dialog may focus the field itself after it opens; the first focus preselects the name.
  const preselected = useRef(false);

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
    void onRename(draft).then(
      () => {
        setRenaming(false);
        onOpenChange(false);
      },
      (cause: unknown) => {
        setRenaming(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While the rename is in flight the dialog is not dismissable
        // (Escape, backdrop): closing it would re-enable typing in the
        // renamed session mid-request. Cancellation stays available
        // before submit via Cancel.
        if (!renaming) onOpenChange(next);
      }}
    >
      <DialogContent aria-busy={renaming} showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <div className="grid gap-2">
          <Label htmlFor={inputId}>{label}</Label>
          <Input
            id={inputId}
            ref={inputRef}
            value={draft}
            disabled={renaming}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => {
              if (preselected.current) return;
              preselected.current = true;
              event.currentTarget.setSelectionRange(0, selectLength);
            }}
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
            <p id={errorId} role="alert" className={dialogError}>
              {error}
            </p>
          )}
        </div>
        {renaming && (
          <p role="status" className={dialogPending}>
            {pendingLabel}
          </p>
        )}
        <DialogFooter>
          {renaming ? (
            <Button variant="outline" disabled>
              Cancel
            </Button>
          ) : (
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          )}
          <Button onClick={submit} disabled={renaming}>
            {renaming ? pendingLabel : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

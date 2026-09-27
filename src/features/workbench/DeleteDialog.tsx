import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import type { DeletePlan, DeleteRequest } from "./deletePlan";
import { dialogError } from "./dialogMessages";

/** Confirm a delete: what goes, which files still refer to it, and anything that has to be settled first. */
export function DeleteDialog({ request, plan, pending, deleting, error, stale, onCommit, onClose }: {
  request: DeleteRequest; plan: DeletePlan | null; pending: boolean;
  /** The delete is saving, so it can no longer be cancelled. */
  deleting: boolean;
  error: string | null;
  /** The files changed after the confirmation opened, and `plan` is the new one. */
  stale: boolean;
  onCommit: () => void; onClose: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const folder = "folder" in request;
  const path = folder ? request.folder : request.path;
  return <AlertDialog open onOpenChange={open => { if (!open && !deleting) onClose(); }}>
    <DialogContent className="wb-move" aria-busy={pending} initialFocus={cancel} showCloseButton={false}
      finalFocus={() => [...document.querySelectorAll<HTMLElement>(`[data-tree-row="${folder ? "folder" : "file"}"] > [data-path]`)].find(row => row.dataset.path === path)
        ?? document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')}>
      <DialogTitle>{folder ? `Delete folder ${path}` : `Delete ${path}`}</DialogTitle>
      <DialogDescription>
        This removes {path}{folder ? " and everything in it" : ""} from the project, for everyone who can open it.
      </DialogDescription>
      {stale && <p role="status">Files changed since this opened. Check what goes now, then delete.</p>}
      {plan && <section aria-label="What goes" className="wb-move-preview">
        {plan.files.length > 0 && <><h3>Files to delete</h3><ul>{plan.files.map(file => <li key={file}>{file}</li>)}</ul></>}
        {plan.folders.length > 0 && <><h3>Folders to delete</h3><ul>{plan.folders.map(entry => <li key={entry}>{entry}</li>)}</ul></>}
        {plan.references.length > 0 && <><h3>Files that refer to it</h3>
          <p>Their references stay as they are.</p>
          <ul>{plan.references.map(entry => <li key={entry.path}>
            {entry.path}<ul>{entry.references.map((reference, index) => <li key={index}>Line {reference.line}: {reference.to}</li>)}</ul>
          </li>)}</ul></>}
        {plan.blockers.map((blocker, index) => <p role="alert" className={dialogError} key={index}>{blocker.path}: {blocker.reason}</p>)}
      </section>}
      {error && <p role="alert" className={dialogError}>{error}</p>}
      {pending && <p role="status">Working…</p>}
      <DialogFooter>
        <Button ref={cancel} variant="outline" disabled={deleting} onClick={onClose}>Cancel</Button>
        <Button variant="destructive" disabled={pending || !plan || plan.blockers.length > 0 || Boolean(error)} onClick={onCommit}>Delete</Button>
      </DialogFooter>
    </DialogContent>
  </AlertDialog>;
}

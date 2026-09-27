import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { MovePlan } from "./movePlan";

/** Pick a folder, preview what moves and which references change, then move. */
export function MoveDialog({ path, kind = "file", folders, folder, plan, pending, error, stale, onFolder, onPreview, onCommit, onClose }: {
  /** The file or folder to move. */
  path: string; kind?: "file" | "folder"; folders: readonly string[]; folder: string;
  plan: MovePlan | null; pending: boolean; error: string | null;
  /** The files changed after the preview, and `plan` is the new one. */
  stale: boolean;
  onFolder: (path: string) => void; onPreview: () => void;
  onCommit: () => void; onClose: () => void;
}) {
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  // A folder cannot go into itself or one of its own folders.
  const destinations = kind === "folder" ? folders.filter(entry => entry !== path && !entry.startsWith(`${path}/`)) : folders;
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="wb-rename wb-move" aria-busy={pending} initialFocus={select} showCloseButton={false}
      finalFocus={() => [...document.querySelectorAll<HTMLButtonElement>(kind === "folder" ? ".wb-tree-select" : ".wb-explorer-open")].find(button => button.title === path) ?? document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')}>
      <DialogTitle>{kind === "folder" ? "Move folder" : "Move to folder"}</DialogTitle>
      <DialogDescription>{kind === "folder"
        ? <>Move {path} and everything in it. References to its files are updated in the same save.</>
        : <>Move {path}. References to it are updated in the same save, and a diagram's generated files move with it.</>}</DialogDescription>
      <div className="grid gap-2">
        <Label htmlFor={id}>Destination folder</Label>
        <select ref={select} id={id} value={folder} disabled={pending} onChange={event => onFolder(event.target.value)}>
          <option value="">Top level</option>
          {destinations.map(entry => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </div>
      <Button variant="secondary" className="justify-self-start" disabled={pending} onClick={onPreview}>Preview move</Button>
      {stale && <p role="status">Files changed since the preview. Check the new preview, then move.</p>}
      {plan && <section aria-label="Affected files" className="wb-move-preview">
        {plan.folder && <><h3>Folder to move</h3><p>{plan.folder.from} → {plan.folder.to}</p></>}
        {plan.moves.length > 0 && <><h3>Files to move</h3>
        <ul>{plan.moves.map(move => <li key={move.from}>{move.from} → {move.to}</li>)}</ul></>}
        {plan.updates.length > 0 && <><h3>References to update</h3><ul>{plan.updates.map(update => <li key={update.path}>
          {update.path}<ul>{update.references.map((reference, index) => <li key={index}>Line {reference.line}: {reference.from} → {reference.to}</li>)}</ul>
        </li>)}</ul></>}
        {plan.blockers.map((blocker, index) => <p role="alert" className="wb-rename-error" key={index}>{blocker.path}: {blocker.reason}</p>)}
      </section>}
      {error && <p role="alert" className="wb-rename-error">{error}</p>}
      {pending && <p role="status">Working…</p>}
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button disabled={pending || !plan || plan.blockers.length > 0 || Boolean(error)} onClick={onCommit}>Move</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

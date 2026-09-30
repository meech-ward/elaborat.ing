import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { moduleLoader, useModule } from "@/lib/moduleLoader";
import type { MoveDialog as MoveDialogComponent } from "./MoveDialog";

// The move dialog, with the select it picks a folder in, loads in its own
// chunk the first time it opens, off the project page's first paint.
const moveDialog = moduleLoader(() => import("./MoveDialog"));

/** MoveDialog once its chunk has loaded: nothing until then, and Try again when it fails. */
export function LazyMoveDialog(props: ComponentProps<typeof MoveDialogComponent>) {
  const { module, error, retry } = useModule(moveDialog, true);
  if (module) {
    const { MoveDialog } = module;
    return <MoveDialog {...props} />;
  }
  if (!error) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{props.kind === "folder" ? "Move folder" : "Move to folder"}</DialogTitle>
          <DialogDescription>This could not load. Check your connection and try again.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button type="button" onClick={retry}>Try again</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

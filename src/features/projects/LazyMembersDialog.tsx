import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import type { MembersDialog as MembersDialogComponent } from "./MembersDialog"

// The members dialog loads in its own chunk the first time it opens, so it
// stays out of the first paint of the home and project pages.
const membersDialog = moduleLoader(() => import("./MembersDialog"))

/** MembersDialog once its chunk has loaded: nothing until then, and Try again when it fails. */
export function LazyMembersDialog(props: ComponentProps<typeof MembersDialogComponent>) {
  const { module, error, retry } = useModule(membersDialog, true)
  if (module) {
    const { MembersDialog } = module
    return <MembersDialog {...props} />
  }
  if (!error) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Members of {props.title}</DialogTitle>
          <DialogDescription>This could not load. Check your connection and try again.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={retry}>
            Try again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

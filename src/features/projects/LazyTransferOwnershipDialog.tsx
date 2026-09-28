import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { AlertDialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import type { TransferOwnershipDialog as TransferOwnershipDialogComponent } from "./TransferOwnershipDialog"

// The transfer dialog loads in its own chunk the first time it opens, so it
// stays out of every page's first paint (Settings, with Delete account, is on
// every page).
const transferDialog = moduleLoader(() => import("./TransferOwnershipDialog"))

/** TransferOwnershipDialog once its chunk has loaded: nothing until then, and Try again when it fails. */
export function LazyTransferOwnershipDialog(props: ComponentProps<typeof TransferOwnershipDialogComponent>) {
  const { module, error, retry } = useModule(transferDialog, true)
  if (module) {
    const { TransferOwnershipDialog } = module
    return <TransferOwnershipDialog {...props} />
  }
  if (!error) return null
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer {props.title}</DialogTitle>
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
    </AlertDialog>
  )
}

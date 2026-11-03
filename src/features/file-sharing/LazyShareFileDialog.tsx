import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import type { ShareFileDialog as ShareFileDialogComponent } from "./ShareFileDialog"

const shareFileDialog = moduleLoader(() => import("./ShareFileDialog"))

/** File-link management stays out of the project page's first paint. */
export function LazyShareFileDialog(props: ComponentProps<typeof ShareFileDialogComponent>) {
  const { module, error, retry } = useModule(shareFileDialog, true)
  if (module) return <module.ShareFileDialog {...props} />
  if (!error) return null
  return (
    <Dialog open onOpenChange={open => { if (!open) props.onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share file</DialogTitle>
          <DialogDescription>This could not load. Check your connection and try again.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button onClick={retry}>Try again</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

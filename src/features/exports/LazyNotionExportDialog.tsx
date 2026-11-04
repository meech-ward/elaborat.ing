import { LoadingLine } from '@/features/design-system'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { moduleLoader, useModule } from '@/lib/moduleLoader'
import type { NotionExportDialogProps } from './NotionExportDialog'

const notionExportDialog = moduleLoader(() => import('./NotionExportDialog'))
export function LazyNotionExportDialog(props: NotionExportDialogProps) {
  const {module, error, retry} = useModule(notionExportDialog, true)
  if (module) return <module.default {...props} />
  const target = props.format === 'google-docs' ? 'Google Docs' : 'Notion'
  return <Dialog open onOpenChange={open => {if (!open) props.onClose()}}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>Export to {target}</DialogTitle>
        <DialogDescription>{error ? 'This could not load. Check your connection and try again.' : props.path}</DialogDescription>
      </DialogHeader>
      {!error ? <LoadingLine label={`Loading ${target} export`} /> : null}
      <DialogFooter><Button variant="outline" onClick={props.onClose}>Cancel</Button>
        {error ? <Button onClick={retry}>Try again</Button> : null}</DialogFooter>
    </DialogContent>
  </Dialog>
}

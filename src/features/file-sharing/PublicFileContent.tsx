import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { SharedFileRenderer } from './SharedFileRenderer'
import { useSharedDiscussion } from './useSharedDiscussion'
import type { SharedBundle } from './publicRemote'

export function PublicFileContent({token, bundle, onUnavailable}: {token: string; bundle: SharedBundle; onUnavailable: () => void}) {
  const root = bundle.files.find(file => file.id === bundle.share.file_id)!
  const discussion = useSharedDiscussion(token, bundle, onUnavailable)
  const [separate, setSeparate] = useState<string | null>(null)
  const opened = bundle.files.find(file => file.path === separate)
  return <main className="mx-auto max-w-[1500px] px-3 py-6 sm:px-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="min-w-0 break-all text-xl font-semibold">{root.path.split('/').pop()}</h1>
      <div className="flex items-center gap-2"><Button variant="secondary" onClick={discussion.toggle} aria-expanded={discussion.open}>Comments</Button>
        {discussion.canComment ? <Button onClick={discussion.start}>Add comment</Button> : null}</div>
    </div>
    {bundle.share.archived ? <p className="mb-4 text-sm text-muted-foreground">This project is archived. Comments are read only.</p> : null}
    <div className="flex min-w-0 flex-col items-start gap-6 lg:flex-row">
      <section aria-label="Shared file" className="min-w-0 w-full flex-1 rounded-xl border border-border bg-panel p-1 sm:p-3">
        <SharedFileRenderer bundle={bundle} file={root} comments={discussion.comments} apiRef={discussion.apiRef} onOpenEmbedded={setSeparate} />
      </section>
      {discussion.panel}
    </div>
    <Dialog open={opened !== undefined} onOpenChange={value => {if (!value) setSeparate(null)}}>
      <DialogContent className="max-h-[90dvh] w-[95vw] max-w-5xl overflow-y-auto">
        <DialogTitle>{opened?.path ?? 'Embedded document'}</DialogTitle>
        {opened ? <SharedFileRenderer bundle={bundle} file={opened} onOpenEmbedded={setSeparate} /> : null}
      </DialogContent>
    </Dialog>
  </main>
}

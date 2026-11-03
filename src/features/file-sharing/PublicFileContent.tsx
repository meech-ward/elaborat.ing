import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { MessageSquare, MessageSquarePlus } from 'lucide-react'
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
  return <main className="flex h-full min-h-0 w-full overflow-hidden" aria-labelledby="shared-file-title">
    <h1 id="shared-file-title" className="sr-only">{root.path.split('/').pop()}</h1>
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <section aria-label="Shared file" className="min-h-0 min-w-0 flex-1">
        <SharedFileRenderer bundle={bundle} file={root} comments={discussion.comments} apiRef={discussion.apiRef} onOpenEmbedded={setSeparate} bottomInset={72}
          place={discussion.readingPlace} onPlaceShown={discussion.readingPlaceShown} />
      </section>
      <div className="pointer-events-none absolute inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-20 flex items-end justify-between gap-3 sm:inset-x-4">
        <div className="pointer-events-auto flex h-11 min-w-0 max-w-[calc(100%_-_7rem)] items-center gap-3 rounded-panel border border-border bg-panel/95 px-3 text-xs shadow-panel backdrop-blur-sm">
          <Link to="/" className="shrink-0 font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">elaborat.ing</Link>
          <span className="hidden min-w-0 truncate text-muted-foreground sm:block" title={root.path}>{root.path.split('/').pop()}</span>
          <span className="sr-only">Shared file, read only{bundle.share.archived ? '. This project is archived. Comments are read only.' : ''}</span>
        </div>
        <div role="group" aria-label="Shared file controls" className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-panel border border-border bg-panel/95 p-0.5 shadow-panel backdrop-blur-sm">
          <Button id="shared-comments-toggle" variant="ghost" size="icon-lg" className="size-10" onClick={discussion.toggle} aria-expanded={discussion.open} aria-label="Comments" title="Comments"><MessageSquare aria-hidden="true" /></Button>
          {discussion.canComment ? <Button variant="ghost" size="icon-lg" className="size-10" onClick={discussion.start} aria-label="Add comment" title="Add comment"><MessageSquarePlus aria-hidden="true" /></Button> : null}
        </div>
      </div>
    </div>
    {discussion.panel}
    <Dialog open={opened !== undefined} onOpenChange={value => {if (!value) setSeparate(null)}}>
      <DialogContent className="flex h-[90dvh] max-h-[90dvh] w-[95vw] max-w-5xl flex-col overflow-hidden">
        <DialogTitle>{opened?.path ?? 'Embedded document'}</DialogTitle>
        <div className="min-h-0 flex-1">{opened ? <SharedFileRenderer bundle={bundle} file={opened} onOpenEmbedded={setSeparate} /> : null}</div>
      </DialogContent>
    </Dialog>
  </main>
}

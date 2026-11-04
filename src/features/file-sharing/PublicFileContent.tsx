import { useCallback, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Download, MessageSquare, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ActionMenu } from '@/features/design-system'
import { isDocumentPath } from '@/features/document/documentPaths'
import { LazyNotionExportDialog } from '@/features/exports/LazyNotionExportDialog'
import type { DocumentExportFormat } from '@/features/exports/NotionExportDialog'
import type { NotionWorkspace, StaticIsland } from '@/features/exports/notionExport'
import type { RenderedEditorApi } from '@/features/rendered'
import { SharedFileRenderer } from './SharedFileRenderer'
import { useSharedDiscussion } from './useSharedDiscussion'
import {completeSharedBundle, type SharedBundle, type SharedFile} from './publicRemote'

type SnapshotSource = {bundle: SharedBundle; file: SharedFile; api: React.RefObject<RenderedEditorApi | null>}
type SnapshotLookup = (path: string, source: string) => Promise<StaticIsland[]> | null
type SharedExport = {path: string; capture: () => Promise<{source: string; sources: ReadonlyMap<string, string>}>; client: NotionWorkspace; format: DocumentExportFormat}

/** Freeze the delivered capability snapshot on click. The adapter and image
 * validation load only if the person goes on to prepare the export. */
function captureSharedExport(token: string, bundle: SharedBundle, format: DocumentExportFormat): SharedExport {
  const snapshot = structuredClone(bundle)
  const root = snapshot.files.find(file => file.id === snapshot.share.file_id)!
  let complete: Promise<SharedBundle> | undefined
  const finish = () => complete ??= completeSharedBundle(token, snapshot)
  let loading: Promise<NotionWorkspace> | undefined
  const load = () => loading ??= Promise.all([import('./sharedNotionWorkspace'), finish()])
    .then(([{sharedNotionWorkspace}, completed]) => sharedNotionWorkspace(completed))
  return {
    path: root.path, format,
    capture: async () => {
      const completed = await finish()
      const imagePaths = new Set([...completed.images.map(image => image.path), ...(completed.pendingImages ?? []).map(image => image.path)])
      return {source: root.content, sources: new Map(completed.files.filter(file => !imagePaths.has(file.path)).map(file => [file.path, file.content]))}
    },
    client: {
      read: path => load().then(client => client.read(path)),
      readImage: (path, preview) => load().then(client => client.readImage!(path, preview)),
      readImageRevision: (path, revision, preview) => load().then(client => client.readImageRevision!(path, revision, preview)),
    },
  }
}

/** A new share revision remounts just this control, canceling its operation
 * and dropping a prepared ZIP without replacing the reader or comments. */
function SharedExportControl({token, bundle, existingSnapshot}: {token: string; bundle: SharedBundle; existingSnapshot: SnapshotLookup}) {
  const [request, setRequest] = useState<SharedExport | null>(null)
  return <>
    <ActionMenu contentProps={{align: 'end', 'aria-label': 'Export formats', finalFocus: request ? false : undefined}}
      entries={[
        {label: 'Export to Notion', onSelect: () => setRequest(captureSharedExport(token, bundle, 'notion'))},
        {label: 'Export to Google Docs', onSelect: () => setRequest(captureSharedExport(token, bundle, 'google-docs'))},
      ]}
      trigger={<Button variant="ghost" size="sm" className="h-10 gap-1.5 px-2.5 text-xs sm:text-sm" aria-label="Export" title="Export">
        <Download aria-hidden="true" className="size-4" />Export
      </Button>} />
    {request ? <LazyNotionExportDialog key={request.format} path={request.path} client={request.client} format={request.format} savedOnly
      capture={request.capture}
      existingSnapshot={existingSnapshot} projectFileUrl={() => null} onClose={() => setRequest(null)} /> : null}
  </>
}

export function PublicFileContent({token, bundle, onUnavailable, onRequestImages, onReadFile}: {token: string; bundle: SharedBundle; onUnavailable: () => void; onRequestImages: (paths: string[]) => void; onReadFile: (path: string) => Promise<SharedFile>}) {
  const root = bundle.files.find(file => file.id === bundle.share.file_id)!
  const discussion = useSharedDiscussion(token, bundle, onUnavailable)
  const [separate, setSeparate] = useState<string | null>(null)
  const opened = bundle.files.find(file => file.path === separate)
  const snapshotSources = useRef(new Set<SnapshotSource>())
  const registerSnapshot = useCallback((file: SharedFile, api: React.RefObject<RenderedEditorApi | null>) => {
    const source = {bundle, file, api}
    snapshotSources.current.add(source)
    return () => {snapshotSources.current.delete(source)}
  }, [bundle])
  const existingSnapshot = useCallback<SnapshotLookup>((path, source) => {
    for (const registered of snapshotSources.current) {
      if (registered.bundle === bundle && registered.file.path === path && registered.file.content === source && registered.api.current)
        return registered.api.current.exportSnapshot()
    }
    return null
  }, [bundle])
  const exportKey = `${bundle.share.id}:${bundle.share.file_id}:${bundle.share.revision}:${bundle.share.version}:${bundle.share.path}:${bundle.share.archived}`
  return <main className="flex h-full min-h-0 w-full overflow-hidden" aria-labelledby="shared-file-title">
    <h1 id="shared-file-title" className="sr-only">{root.path.split('/').pop()}</h1>
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <section aria-label="Shared file" className="min-h-0 min-w-0 flex-1">
        <SharedFileRenderer onReadFile={onReadFile} onRequestImages={onRequestImages} bundle={bundle} file={root} comments={discussion.comments} apiRef={discussion.apiRef} onOpenEmbedded={setSeparate} bottomInset={72}
          place={discussion.readingPlace} onPlaceShown={discussion.readingPlaceShown} registerSnapshot={registerSnapshot} />
      </section>
      <div className="pointer-events-none absolute inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-20 flex items-end justify-between gap-3 sm:inset-x-4">
        <div className="pointer-events-auto flex h-11 min-w-0 max-w-[calc(100%_-_7rem)] items-center gap-3 rounded-panel border border-border bg-panel/95 px-3 text-xs shadow-panel backdrop-blur-sm">
          <Link to="/" className="shrink-0 font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">elaborat.ing</Link>
          <span className="hidden min-w-0 truncate text-muted-foreground sm:block" title={root.path}>{root.path.split('/').pop()}</span>
          <span className="sr-only">Shared file, read only{bundle.share.archived ? '. This project is archived. Comments are read only.' : ''}</span>
        </div>
        <div role="group" aria-label="Shared file controls" className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-panel border border-border bg-panel/95 p-0.5 shadow-panel backdrop-blur-sm">
          {isDocumentPath(root.path) && !bundle.images.some(image => image.path === root.path)
            ? <SharedExportControl key={exportKey} token={token} bundle={bundle} existingSnapshot={existingSnapshot} /> : null}
          <Button id="shared-comments-toggle" variant="ghost" size="icon-lg" className="size-10" onClick={discussion.toggle} aria-expanded={discussion.open} aria-label="Comments" title="Comments"><MessageSquare aria-hidden="true" /></Button>
          {discussion.canComment ? <Button variant="ghost" size="icon-lg" className="size-10" onClick={discussion.start} aria-label="Add comment" title="Add comment"><MessageSquarePlus aria-hidden="true" /></Button> : null}
        </div>
      </div>
    </div>
    {discussion.panel}
    <Dialog open={opened !== undefined} onOpenChange={value => {if (!value) setSeparate(null)}}>
      <DialogContent className="flex h-[90dvh] max-h-[90dvh] w-[95vw] max-w-5xl flex-col overflow-hidden">
        <DialogTitle>{opened?.path ?? 'Embedded document'}</DialogTitle>
        <div className="min-h-0 flex-1">{opened ? <SharedFileRenderer onReadFile={onReadFile} onRequestImages={onRequestImages} bundle={bundle} file={opened} onOpenEmbedded={setSeparate} registerSnapshot={registerSnapshot} /> : null}</div>
      </DialogContent>
    </Dialog>
  </main>
}

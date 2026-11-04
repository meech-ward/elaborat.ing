import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Banner, LoadingLine } from '@/features/design-system'
import { useCustomCodePolicy } from '@/features/custom-code'
import { downloadBlob } from '@/features/workbench/download'
import { buildNotionExport, type NotionExportResult, type NotionWorkspace, type SnapshotRequest, type StaticIsland } from './notionExport'
import { NotionSnapshotRenderer, type NotionRenderRequest } from './NotionSnapshotRenderer'

export type DocumentExportFormat = 'notion' | 'google-docs'
export type NotionExportDialogProps = {
  path: string; client: NotionWorkspace;
  capture: () => Promise<{source: string; sources: ReadonlyMap<string, string>}>;
  existingSnapshot: (path: string, source: string) => Promise<StaticIsland[]> | null;
  projectFileUrl: (path: string) => string | null;
  format?: DocumentExportFormat;
  savedOnly?: boolean;
  onClose: () => void;
}

export default function NotionExportDialog({path, client, capture, existingSnapshot, projectFileUrl, format = 'notion', savedOnly = false, onClose}: NotionExportDialogProps) {
  const policy = useCustomCodePolicy()
  const googleDocs = format === 'google-docs'
  const [result, setResult] = useState<NotionExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState('Preparing the document')
  const [busy, setBusy] = useState(false)
  const [render, setRender] = useState<NotionRenderRequest | null>(null)
  const operation = useRef<AbortController | null>(null)
  const renderId = useRef(0)
  const activeRender = useRef<NotionRenderRequest | null>(null)
  useEffect(() => () => {operation.current?.abort(); activeRender.current?.reject(new Error('Export canceled.'))}, [])
  const snapshot = useCallback(async (request: SnapshotRequest, controller: AbortController): Promise<StaticIsland[]> => {
    controller.signal.throwIfAborted()
    const existing = existingSnapshot(request.path, request.source)
    if (existing) {
      try {return await existing} catch {controller.signal.throwIfAborted()}
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => finish(new Error('The component preview took too long to export.')), 30_000)
      const finish = (error?: Error, islands?: StaticIsland[]) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        controller.signal.removeEventListener('abort', abort)
        activeRender.current = null
        setRender(null)
        if (error) reject(error); else resolve(islands ?? [])
      }
      const abort = () => finish(new Error('Export canceled.'))
      const next: NotionRenderRequest = {...request, id: ++renderId.current, policy, signal: controller.signal,
        resolve: islands => finish(undefined, islands), reject: error => finish(error)}
      activeRender.current = next
      controller.signal.addEventListener('abort', abort, {once: true})
      setRender(next)
    })
  }, [existingSnapshot, policy])
  const prepare = async () => {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setError(null); setResult(null)
    try {
      const sources = await capture()
      const options = {path, client, ...sources, projectFileUrl,
        signal: controller.signal, onProgress: setProgress, snapshot: (request: SnapshotRequest) => snapshot(request, controller)}
      const build = googleDocs
        ? (await import('./googleDocsExport')).buildGoogleDocsExport
        : buildNotionExport
      controller.signal.throwIfAborted()
      const output = await build(options)
      if (!controller.signal.aborted) setResult(output)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    } finally {if (!controller.signal.aborted) setBusy(false)}
  }
  const close = () => {operation.current?.abort(); onClose()}
  return <>
    <Dialog open onOpenChange={open => {if (!open) close()}}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{googleDocs ? 'Export to Google Docs' : 'Export to Notion'}</DialogTitle>
          <DialogDescription className="wrap-anywhere">{path}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <p>{googleDocs ? 'Creates a DOCX on this device with editable text and embedded images. ' : 'Creates a ZIP on this device with editable text and included image files. '}{savedOnly
            ? 'The saved shared file and its embedded notes are included. No sign-in is needed.'
            : 'Your current unsaved edits and embedded notes are included.'}</p>
          <p>{googleDocs ? 'Upload the downloaded DOCX to Google Drive, then open it with Google Docs.'
            : 'In Notion on desktop or web, choose Settings → Import → ZIP, then select the downloaded file.'}</p>
          {busy ? <LoadingLine label={progress} /> : null}
          {error ? <Banner tone="danger" role="alert">{error}</Banner> : null}
          {result ? <>
            <p role="status">Ready: {result.documentCount} {result.documentCount === 1 ? 'document' : 'documents'} and {result.assetCount} {result.assetCount === 1 ? 'image' : 'images'}.</p>
            {result.diagnostics.length ? <div className="flex flex-col gap-2">
              <p>Some content was simplified for export. Review the notes below.</p>
              <ul aria-label="Export notes" className="max-h-48 list-disc overflow-auto pl-5 wrap-anywhere">
                {result.diagnostics.slice(0, 100).map((note, index) => <li key={index}>{note.sourcePath}: {note.message}</li>)}
              </ul>
            </div> : <p>Text remains editable. Interactive components are included as static content.</p>}
          </> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>{busy || !result ? 'Cancel' : 'Close'}</Button>
          {result ? <Button onClick={() => downloadBlob(new Blob([result.bytes], {type: googleDocs
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/zip'}), result.filename)}>{googleDocs ? 'Download DOCX' : 'Download ZIP'}</Button>
            : <Button disabled={busy} onClick={() => void prepare()}>{busy ? 'Preparing…' : error ? 'Try again' : 'Prepare export'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {render ? <NotionSnapshotRenderer key={render.id} request={render} /> : null}
  </>
}

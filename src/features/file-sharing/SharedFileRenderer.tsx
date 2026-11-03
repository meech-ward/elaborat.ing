import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banner, LoadingLine } from '@/features/design-system'
import { useComponentEnvironment } from '@/features/document/useComponentEnvironment'
import { LazyRenderedEditor } from '@/features/workbench/LazyRenderedEditor'
import { resolveNoteLink } from '@/features/workbench/noteLinks'
import type { DocumentEmbedHost } from '@/features/rendered/documentEmbeds'
import { MAX_DOCUMENT_EMBED_DEPTH } from '@/features/rendered/documentEmbeds'
import { isDocumentPath } from '@/features/document/documentPaths'
import type { RenderedComments, RenderedEditorApi, RenderedEditorProps } from '@/features/rendered'
import { parseImageReferences } from '@/features/images/referenceParser'
import type { ImagePreview } from '@/features/images/transport'
import { drawingSvgForContent, diagramSvgForWorkspace } from '@/features/workbench/resources'
import { MissingFileError } from '@/features/workbench/workspaceStore'
import type { SharedBundle, SharedFile } from './publicRemote'

type Attached = Parameters<DocumentEmbedHost['attach']>[0]
type Budget = {reserve: () => boolean; release: () => void}
function documentBudget(): Budget {
  let count = 0
  return {
    reserve() {if (count >= 64) return false; count++; return true},
    release() {count = Math.max(0, count - 1)},
  }
}
type Props = {
  bundle: SharedBundle; file: SharedFile; comments?: RenderedComments;
  apiRef?: React.RefObject<RenderedEditorApi | null>;
  onOpenEmbedded: (path: string) => void;
  bottomInset?: number;
  place?: RenderedEditorProps['place'];
  onPlaceShown?: () => void;
}

function useResourcePixels(bundle: SharedBundle) {
  const [state, setState] = useState<{bundle: SharedBundle; pixels: Record<string, string>; error?: string} | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      const pixels: Record<string, string> = Object.create(null)
      const errors: string[] = []
      for (const file of bundle.files) {
        if (!alive) return
        if (!/\.(?:excalidraw(?:\.md)?|d2)$/i.test(file.path)) continue
        try {
          if (/\.d2$/i.test(file.path)) pixels[file.path] = await diagramSvgForWorkspace(file.content, file.path, {
            read: async path => {
              const found = bundle.files.find(f => f.path === path)
              if (!found) throw new MissingFileError(path)
              return {path, content: found.content, savedContent: found.content, revision: String(found.version),
                size: new TextEncoder().encode(found.content).byteLength, draft: false, unsynced: false, conflict: false,
                server: {id: found.id, version: found.version}}
            },
          })
          else {
            const {parseDrawingFile} = await import('@/features/drawings/parse')
            if (parseDrawingFile(file.content, file.path).scene.elements.length) pixels[file.path] = await drawingSvgForContent(file.content, file.path)
            else pixels[file.path] = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="20" y="60" fill="#777">This drawing is empty.</text></svg>'
          }
        } catch {errors.push(file.path)}
      }
      if (alive) setState({bundle, pixels, ...(errors.length ? {error: `Some drawings could not render: ${errors.join(', ')}`} : {})})
    })()
    return () => {alive = false}
  }, [bundle])
  return state?.bundle === bundle ? state : null
}

export function SharedFileRenderer(props: Props) {
  const pixels = useResourcePixels(props.bundle)
  const [budget] = useState(documentBudget)
  const image = props.bundle.images.find(i => i.path === props.file.path)
  if (image) return <figure className="h-full min-h-0 p-4" style={{paddingBottom: 16 + (props.bottomInset ?? 0)}}><img src={image.dataURL} alt={props.file.path.split('/').pop() ?? 'Shared image'} width={image.width} height={image.height} className="h-full w-full object-contain" /></figure>
  if (/\.(?:excalidraw(?:\.md)?|d2)$/i.test(props.file.path)) {
    if (!pixels) return <LoadingLine label="Rendering drawing" />
    const svg = pixels.pixels[props.file.path]
    return svg ? <img alt={`Shared drawing ${props.file.path}`} className="h-full w-full object-contain p-4" style={{paddingBottom: 16 + (props.bottomInset ?? 0)}} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />
      : <Banner tone="danger">The drawing could not render.</Banner>
  }
  if (!/\.(?:md|mdx)$/i.test(props.file.path)) return <Banner>This file type has no rendered preview.</Banner>
  return <div className="flex h-full min-h-0 flex-col">{pixels?.error ? <Banner tone="warn">{pixels.error}</Banner> : null}
    <SharedNote {...props} resources={pixels?.pixels ?? {}} budget={budget} />
  </div>
}

function SharedNote({bundle, file, comments, apiRef, onOpenEmbedded, resources, budget, embed, bottomInset = 0, place, onPlaceShown}: Props & {
  resources: Record<string, string>; budget: Budget; embed?: Attached
}) {
  const format = /\.mdx$/i.test(file.path) ? 'mdx' : 'md'
  const load = useCallback(async (path: string) => {
    const module = bundle.files.find(f => f.path === path)
    if (!module) throw new Error('This component is not included in the shared file.')
    return {text: module.content, revision: String(module.version)}
  }, [bundle])
  const componentState = useComponentEnvironment(file.content, format === 'mdx', load, bundle.share.revision, undefined, file.version)
  const [views, setViews] = useState<Attached[]>([])
  const viewMap = useRef(new Map<string, Attached>())
  const onOpen = useRef(onOpenEmbedded)
  useEffect(() => {onOpen.current = onOpenEmbedded}, [onOpenEmbedded])
  const allowed = useMemo(() => new Set(bundle.files.filter(f => /\.(?:md|mdx)$/i.test(f.path)).map(f => f.path)), [bundle])
  const host = useMemo<DocumentEmbedHost>(() => ({
    attach(request) {
      if (!isDocumentPath(request.path) || !allowed.has(request.path) || viewMap.current.has(request.id) ||
        request.ancestors.length < 2 || request.ancestors.length > MAX_DOCUMENT_EMBED_DEPTH ||
        request.ancestors.at(-2) !== file.path || request.ancestors.at(-1) !== request.path ||
        new Set(request.ancestors).size !== request.ancestors.length || !budget.reserve()) {
        request.onState({pending: false, readOnly: true, needsCodeConsent: false, error: 'This embedded document is unavailable or too many documents are open.'})
        return () => {}
      }
      const view = request
      viewMap.current.set(request.id, view)
      setViews([...viewMap.current.values()])
      request.onState({pending: true, readOnly: true, needsCodeConsent: false})
      let removed = false
      return () => {
        if (removed) return
        removed = true
        if (!viewMap.current.has(request.id)) return
        budget.release()
        viewMap.current.delete(request.id)
        setViews([...viewMap.current.values()])
      }
    },
    action(id, action) {
      const view = viewMap.current.get(id)
      if (!view) return
      if (action === 'open') onOpen.current(view.path)
    },
  }), [allowed, budget, file.path])
  useEffect(() => {
    const attached = viewMap.current
    return () => {
      // A closed/replaced note can unmount before its child frames send their
      // release messages. Return all of this note's reservations exactly once.
      for (let count = 0; count < attached.size; count++) budget.release()
      attached.clear()
    }
  }, [budget])
  const [notice, setNotice] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [images, setImages] = useState<{file: SharedFile; pixels: Record<string, ImagePreview>; paths: Map<string, string>} | null>(null)
  const imageModules = useMemo(() => componentState.environment?.code.filter(module => module.path !== null)
    .map(module => ({path: module.path!, esm: module.esm})) ?? [], [componentState.environment])
  useEffect(() => {
    let alive = true
    void parseImageReferences(file.content, format, file.path, imageModules).then(refs => {
      const pixels: Record<string, ImagePreview> = Object.create(null)
      const paths = new Map<string, string>()
      for (const ref of refs) {
        const image = bundle.images.find(i => i.path === ref.path)
        if (image) {pixels[ref.key] = image.preview; paths.set(ref.key, image.path)}
      }
      if (alive) setImages({file, pixels, paths})
    }, () => {if (alive) setImages({file, pixels: {}, paths: new Map()})})
    return () => {alive = false}
  }, [file, format, bundle, imageModules])
  const readImage = useCallback(async (key: string): Promise<ImagePreview> => {
    const path = images?.file === file ? images.paths.get(key) : null
    const image = path && bundle.images.find(i => i.path === path)
    if (!image) throw new Error('This image is not included in the shared file.')
    return {dataURL: image.dataURL, width: image.width, height: image.height}
  }, [images, file, bundle])
  const contentHeight = useCallback((value: number) => {
    const bounded = Math.min(2_000_000, Math.max(320, value))
    if (embed) embed.onState({height: bounded, pending: false, readOnly: true})
  }, [embed])
  useEffect(() => {
    embed?.onState({pending: Boolean(componentState.pending), needsCodeConsent: false, readOnly: true, error: renderError ?? componentState.error ?? null})
  }, [embed, componentState.pending, componentState.error, renderError])
  const openLink = (href: string) => {
    const link = resolveNoteLink(href, file.path)
    if (link.kind === 'web') window.open(link.url, '_blank', 'noopener,noreferrer')
    else if (link.kind === 'file') setNotice('That link points to another project file. It needs its own share link.')
  }
  return <>
    {!embed && notice ? <Banner className="m-3">{notice}</Banner> : null}
    {!embed && renderError ? <Banner tone="danger" className="m-3">{renderError}</Banner> : null}
    <div style={embed ? {display: 'contents'} : {height: '100%', flex: '1 1 0%', minHeight: 0, minWidth: 0}}>
      <LazyRenderedEditor document={{text: file.content, format, revision: file.version}} documentId={file.version} documentPath={file.path}
        externalFrame={embed?.frame} externalFrameScriptUrl={embed?.frameScriptUrl} embeddedAncestors={embed?.ancestors ?? [file.path]}
        documentEmbedHost={host} componentEnvironment={componentState.environment} componentError={componentState.error} componentPending={componentState.pending}
        readOnly onPatch={() => false} onOpenLink={openLink} onError={setRenderError} errorBanner={false}
        minViewportHeight={0} bottomInset={embed ? 0 : bottomInset}
        resources={resources} allowedResourcePaths={Object.keys(resources)} imageResources={images?.file === file ? images.pixels : {}} onReadImage={readImage}
        onContentHeight={embed ? contentHeight : undefined} comments={comments} apiRef={apiRef} place={place} onPlaceShown={onPlaceShown} />
    </div>
    {views.map(view => {
      const child = bundle.files.find(f => f.path === view.path)
      return child ? <SharedNote key={view.id} bundle={bundle} file={child} resources={resources} budget={budget}
        embed={view} onOpenEmbedded={onOpenEmbedded} /> : null
    })}
  </>
}

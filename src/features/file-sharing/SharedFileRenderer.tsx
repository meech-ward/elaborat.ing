import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { parseSourceRefs } from '@/features/workbench/refs'
import { prepareVisibleAssets } from '@/features/workbench/progressiveAssets'
import { SharedResourcePixels, type ResourceTarget, type ResourceSnapshot } from './resourcePixels'
import type { SharedBundle, SharedFile } from './publicRemote'

type Attached = Parameters<DocumentEmbedHost['attach']>[0] & {active?: boolean}
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
  onRequestImages: (paths: string[]) => void;
  onReadFile: (path: string) => Promise<SharedFile>;
  bottomInset?: number;
  place?: RenderedEditorProps['place'];
  onPlaceShown?: () => void;
  registerSnapshot?: (file: SharedFile, api: React.RefObject<RenderedEditorApi | null>) => () => void;
}

function useResourcePixels(files: SharedFile[], file: SharedFile, moduleSources = '', enabled = true) {
  const ownDrawing = /\.(?:excalidraw(?:\.md)?|d2)$/i.test(file.path)
  const requested = ownDrawing ? [file.path] : parseSourceRefs(`${file.content}\n${moduleSources}`)
    .filter(ref => ref.kind === 'drawing' || ref.kind === 'diagram').map(ref => ref.path)
  const paths = [...new Set(requested)]
  const targets = paths.flatMap(path => {
    const source = files.find(candidate => candidate.path === path)
    if (!source) return []
    const inputs = /\.d2$/i.test(path) ? [path, path.replace(/\.d2$/i, '.excalidraw'), `${path}.json`] : [path]
    // Companion arrivals invalidate only their own diagram. The serialized
    // authoritative sources also distinguish a replacement at the same path.
    return [{path, identity: JSON.stringify(inputs.map(input => files.find(candidate => candidate.path === input) ?? null))}]
  })
  const targetsKey = JSON.stringify(targets)
  const resourcePaths = new Set(paths.flatMap(path => /\.d2$/i.test(path) ? [path, path.replace(/\.d2$/i, '.excalidraw'), `${path}.json`] : [path]))
  const resourceData = JSON.stringify(files.filter(candidate => resourcePaths.has(candidate.path)))
  const [cache] = useState(() => new SharedResourcePixels())
  const [state, setState] = useState<{file: SharedFile; snapshot: ResourceSnapshot} | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const readyFiles: SharedFile[] = JSON.parse(resourceData)
    const readyTargets: ResourceTarget[] = JSON.parse(targetsKey)
    void cache.prepare(readyTargets, controller.signal, async target => {
      const source = readyFiles.find(candidate => candidate.path === target.path)!
      if (/\.d2$/i.test(target.path)) return diagramSvgForWorkspace(source.content, target.path, {
        read: async path => {
          const found = readyFiles.find(candidate => candidate.path === path)
          if (!found) throw new MissingFileError(path)
          return {path, content: found.content, savedContent: found.content, revision: String(found.version),
            size: new TextEncoder().encode(found.content).byteLength, draft: false, unsynced: false, conflict: false,
            server: {id: found.id, version: found.version}}
        },
      })
      const {parseDrawingFile} = await import('@/features/drawings/parse')
      return parseDrawingFile(source.content, target.path).scene.elements.length ? drawingSvgForContent(source.content, target.path)
        : '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="20" y="60" fill="#777">This drawing is empty.</text></svg>'
    }, snapshot => setState({file, snapshot}))
    return () => controller.abort()
  }, [resourceData, targetsKey, file, enabled, cache])
  if (state?.file !== file) return null
  const identities = new Map(targets.map(target => [target.path, target.identity]))
  const pixels = Object.fromEntries(Object.entries(state.snapshot.pixels)
    .filter(([path]) => identities.get(path) === state.snapshot.identities[path]))
  const errors = state.snapshot.errors.filter(path => identities.get(path) === state.snapshot.identities[path])
  return {file, pixels, failedPaths: errors, ...(errors.length ? {error: `Some drawings could not render: ${errors.join(', ')}`} : {})}
}

export function SharedFileRenderer(props: Props) {
  const pixels = useResourcePixels(props.bundle.files, props.file, '', /\.(?:excalidraw(?:\.md)?|d2)$/i.test(props.file.path))
  const {onRequestImages, file: rootFile} = props
  useEffect(() => {onRequestImages([rootFile.path])}, [rootFile.path, onRequestImages])
  const [budget] = useState(documentBudget)
  const image = props.bundle.images.find(i => i.path === props.file.path)
  const pendingImage = props.bundle.pendingImages?.find(i => i.path === props.file.path)
  if (pendingImage && !image) return props.bundle.imageErrors?.includes(props.file.path)
    ? <Banner tone="warn">This image could not load.</Banner> : <LoadingLine label="Loading shared image" />
  if (image) return <figure className="h-full min-h-0 p-4" style={{paddingBottom: 16 + (props.bottomInset ?? 0)}}><img src={image.dataURL} alt={props.file.path.split('/').pop() ?? 'Shared image'} width={image.width} height={image.height} className="h-full w-full object-contain" /></figure>
  if (/\.(?:excalidraw(?:\.md)?|d2)$/i.test(props.file.path)) {
    if (!pixels) return <LoadingLine label="Rendering drawing" />
    const svg = pixels.pixels[props.file.path]
    return svg ? <img alt={`Shared drawing ${props.file.path}`} className="h-full w-full object-contain p-4" style={{paddingBottom: 16 + (props.bottomInset ?? 0)}} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />
      : pixels.failedPaths.includes(props.file.path) ? <Banner tone="danger">The drawing could not render.</Banner>
      : <LoadingLine label="Rendering drawing" />
  }
  if (!/\.(?:md|mdx)$/i.test(props.file.path)) return <Banner>This file type has no rendered preview.</Banner>
  return <div className="flex h-full min-h-0 flex-col">{pixels?.error ? <Banner tone="warn">{pixels.error}</Banner> : null}
    <SharedNote {...props} budget={budget} />
  </div>
}

function SharedNote({bundle, file, comments, apiRef, onOpenEmbedded, onRequestImages, onReadFile, budget, embed, bottomInset = 0, place, onPlaceShown, registerSnapshot}: Props & {
  budget: Budget; embed?: Attached
}) {
  const format = /\.mdx$/i.test(file.path) ? 'mdx' : 'md'
  const ownApi = useRef<RenderedEditorApi | null>(null)
  const rendererApi = apiRef ?? ownApi
  useEffect(() => registerSnapshot?.(file, rendererApi), [file, rendererApi, registerSnapshot])
  const load = useCallback(async (path: string) => {
    const module = await onReadFile(path)
    return {text: module.content, revision: String(module.version)}
  }, [onReadFile])
  const active = embed?.active !== false
  const componentState = useComponentEnvironment(file.content, active && format === 'mdx', load, bundle.share.revision, undefined, file.version)
  const [views, setViews] = useState<Attached[]>([])
  const viewMap = useRef(new Map<string, Attached>())
  const activeOwners = useRef(new Map<string, boolean>())
  const onOpen = useRef(onOpenEmbedded)
  useEffect(() => {onOpen.current = onOpenEmbedded}, [onOpenEmbedded])
  const host = useMemo<DocumentEmbedHost>(() => ({
    attach(request) {
      if (!isDocumentPath(request.path) || viewMap.current.has(request.id) ||
        request.ancestors.length < 2 || request.ancestors.length > MAX_DOCUMENT_EMBED_DEPTH ||
        request.ancestors.at(-2) !== file.path || request.ancestors.at(-1) !== request.path ||
        new Set(request.ancestors).size !== request.ancestors.length || !budget.reserve()) {
        request.onState({pending: false, readOnly: true, needsCodeConsent: false, error: 'This embedded document is unavailable or too many documents are open.'})
        return () => {}
      }
      const view = {...request, active: request.visible !== false && activeOwners.current.get(request.ownerSession ?? '') !== false}
      viewMap.current.set(request.id, view)
      setViews([...viewMap.current.values()])
      request.onState({pending: true, readOnly: true, needsCodeConsent: false})
      void onReadFile(request.path).catch(() => {
        if (viewMap.current.get(request.id)?.onState === view.onState) request.onState({pending: false, readOnly: true, error: 'This embedded document is unavailable.'})
      })
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
    setActive(session, active) {
      activeOwners.current.set(session, active)
      let changed = false
      for (const [id, view] of viewMap.current) {
        if (view.ownerSession !== session) continue
        const next = view.visible !== false && active
        if (view.active === next) continue
        viewMap.current.set(id, {...view, active: next})
        changed = true
      }
      if (changed) setViews([...viewMap.current.values()])
    },
    setVisible(id, visible) {
      const view = viewMap.current.get(id)
      if (!view || view.visible === visible) return
      viewMap.current.set(id, {...view, visible, active: visible && activeOwners.current.get(view.ownerSession ?? '') !== false})
      setViews([...viewMap.current.values()])
    },
    action(id, action) {
      const view = viewMap.current.get(id)
      if (!view) return
      if (action === 'open') onOpen.current(view.path)
    },
  }), [budget, file.path, onReadFile])
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
  const [imageDimensions, setImageDimensions] = useState<{file: SharedFile; dimensions: Record<string, {width: number; height: number}>} | null>(null)
  const imageModules = JSON.stringify(componentState.environment?.code.filter(module => module.path !== null)
    .map(module => ({path: module.path!, esm: module.esm})) ?? [])
  const drawings = useResourcePixels(bundle.files, file, (JSON.parse(imageModules) as {esm: string}[]).map(module => module.esm).join('\n'), active)
  const resources = drawings?.pixels ?? {}
  const imageCache = useRef(new Map<string, Promise<ImagePreview>>())
  useEffect(() => {
    if (!active) return
    let alive = true
    const controller = new AbortController()
    void parseImageReferences(file.content, format, file.path, JSON.parse(imageModules)).then(async refs => {
      if (!alive) return
      onRequestImages(refs.map(ref => ref.path))
      const [{documentImage}, {decodeImageDataURL}] = await Promise.all([
        import('@/features/images/documentImage'), import('@/features/images/transport'),
      ])
      const pixels: Record<string, ImagePreview> = Object.create(null)
      const paths = new Map<string, string>()
      const dimensions: Record<string, {width: number; height: number}> = Object.create(null)
      for (const ref of refs) {
        const descriptor = bundle.pendingImages?.find(image => image.path === ref.path) ?? bundle.images.find(image => image.path === ref.path)
        if (descriptor) {dimensions[ref.key] = {width: descriptor.width, height: descriptor.height}; paths.set(ref.key, descriptor.path)}
      }
      if (alive) setImageDimensions({file, dimensions})
      let total = 0
      await prepareVisibleAssets(refs, controller.signal, async ref => {
        const image = bundle.images.find(i => i.path === ref.path)
        if (!image) return
        let preparing = imageCache.current.get(image.dataURL)
        if (!preparing) {
          preparing = (async () => {
            try {
              const {bytes, mediaType} = decodeImageDataURL(image.dataURL)
              return await documentImage(new Blob([new Uint8Array(bytes)], {type: mediaType}))
            } catch {return image.preview}
          })()
          imageCache.current.set(image.dataURL, preparing)
        }
        let display = await preparing
        if (!alive) return
        if (total + display.dataURL.length > 20 * 1024 * 1024) display = image.preview
        if (total + display.dataURL.length > 20 * 1024 * 1024) return
        total += display.dataURL.length
        pixels[ref.key] = display
        paths.set(ref.key, image.path)
        setImages(previous => ({file, pixels: {...(previous?.file === file ? previous.pixels : {}), ...pixels},
          paths: new Map([...(previous?.file === file ? previous.paths : []), ...paths])}))
      })
    }).catch(() => {if (alive) setImages({file, pixels: {}, paths: new Map()})})
    return () => {alive = false; controller.abort()}
  }, [file, format, bundle.images, bundle.pendingImages, bundle.imageErrors, imageModules, onRequestImages, active])

  const imageReadState = useRef({images, file, bundle})
  useLayoutEffect(() => {imageReadState.current = {images, file, bundle}})
  const shareId = bundle.share.id, shareRevision = bundle.share.revision
  // The reader is stable as siblings arrive, but a new capability revision
  // replaces it so late original reads cannot enter the refreshed document.
  const readImage = useCallback(async (key: string): Promise<ImagePreview> => {
    const current = imageReadState.current
    if (current.file !== file || current.bundle.share.id !== shareId || current.bundle.share.revision !== shareRevision)
      throw new Error('This shared file changed while loading.')
    const path = current.images?.file === file ? current.images.paths.get(key) : null
    const image = path && current.bundle.images.find(i => i.path === path)
    if (!image) throw new Error('This image is not included in the shared file.')
    return {dataURL: image.dataURL, width: image.width, height: image.height}
  }, [file, shareId, shareRevision])
  const contentHeight = useCallback((value: number) => {
    const bounded = Math.min(2_000_000, Math.max(320, value))
    if (embed) embed.onState({height: bounded, pending: false, readOnly: true})
  }, [embed])
  useEffect(() => {
    embed?.onState({pending: Boolean(componentState.pending), needsCodeConsent: false, readOnly: true, error: renderError ?? null})
  }, [embed, componentState.pending, renderError])
  const openLink = (href: string) => {
    const link = resolveNoteLink(href, file.path)
    if (link.kind === 'web') window.open(link.url, '_blank', 'noopener,noreferrer')
    else if (link.kind === 'file') setNotice('That link points to another project file. It needs its own share link.')
  }
  return <>
    {!embed && notice ? <Banner className="m-3">{notice}</Banner> : null}
    {!embed && renderError ? <Banner tone="danger" className="m-3">{renderError}</Banner> : null}
    <div style={embed ? {display: 'contents'} : {height: '100%', flex: '1 1 0%', minHeight: 0, minWidth: 0}}>
      <LazyRenderedEditor active={active} document={{text: file.content, format, revision: file.version}} documentId={file.version} documentPath={file.path}
        externalFrame={embed?.frame} externalFrameScriptUrl={embed?.frameScriptUrl} embeddedAncestors={embed?.ancestors ?? [file.path]}
        documentEmbedHost={host} componentEnvironment={componentState.environment} componentError={componentState.error} componentPending={componentState.pending}
        readOnly onPatch={() => false} onOpenLink={openLink} onError={setRenderError} errorBanner={false}
        minViewportHeight={0} bottomInset={embed ? 0 : bottomInset}
        resources={resources} allowedResourcePaths={Object.keys(resources)} imageDimensions={imageDimensions?.file === file ? imageDimensions.dimensions : {}} imageResources={images?.file === file ? images.pixels : {}} onReadImage={readImage}
        onContentHeight={embed ? contentHeight : undefined} comments={comments} apiRef={rendererApi} place={place} onPlaceShown={onPlaceShown} />
    </div>
    {views.map(view => {
      const child = bundle.files.find(f => f.path === view.path)
      return child ? <SharedNote key={view.id} bundle={bundle} file={child} budget={budget}
        embed={view} onOpenEmbedded={onOpenEmbedded} onRequestImages={onRequestImages} onReadFile={onReadFile} registerSnapshot={registerSnapshot} /> : null
    })}
  </>
}

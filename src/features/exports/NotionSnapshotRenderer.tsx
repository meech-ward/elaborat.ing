import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentEnvironment } from '@/features/document/componentModules'
import { prepareComponentEnvironment } from '@/features/document/componentModules'
import { savedComponentSource } from '@/features/document/componentSource'
import { approvedCode, codeFiles, waitingFiles, type CustomCodePolicy } from '@/features/custom-code'
import { parseImageReferences } from '@/features/images/references'
import { documentImage } from '@/features/images/documentImage'
import type { ImagePreview } from '@/features/images/transport'
import { drawingSvgForContent, diagramSvgForWorkspace } from '@/features/workbench/resources'
import { parseSourceRefs } from '@/features/workbench/refs'
import { LazyRenderedEditor } from '@/features/workbench/LazyRenderedEditor'
import type { RenderedEditorApi } from '@/features/rendered'
import type { SnapshotRequest, StaticIsland } from './notionExport'

export type NotionRenderRequest = SnapshotRequest & {
  id: number; signal: AbortSignal; policy: CustomCodePolicy | null;
  resolve: (islands: StaticIsland[]) => void; reject: (error: Error) => void;
}
type Prepared = {environment?: ComponentEnvironment; images: Record<string, ImagePreview>; resources: Record<string, string>}

/** A fresh, noninteractive copy for Source mode or an unopened child note.
 * It uses the ordinary opaque preview and never expands or changes live views.
 */
export function NotionSnapshotRenderer({request}: {request: NotionRenderRequest}) {
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const api = useRef<RenderedEditorApi | null>(null)
  const onError = useCallback((message: string | null) => {if (message) request.reject(new Error(message))}, [request])
  useEffect(() => {
    let live = true
    const controller = new AbortController()
    const cancel = () => controller.abort()
    request.signal.addEventListener('abort', cancel, {once: true})
    if (request.signal.aborted) controller.abort()
    void (async () => {
      const {client, path, source, format, policy} = request
      const signal = controller.signal
      signal.throwIfAborted()
      const environment = format === 'mdx' ? await prepareComponentEnvironment(source, async modulePath =>
        savedComponentSource({...await client.read(modulePath), revision: 'export'})) : undefined
      signal.throwIfAborted()
      if (policy && environment && waitingFiles(await codeFiles(environment.code, path), approvedCode(policy.key)).length)
        throw new Error('Open this note in Rendered and run its custom components before exporting their appearance.')
      const modules = environment?.code.flatMap(module => module.path === null ? [] : [{path: module.path, esm: module.esm}]) ?? []
      const images: Record<string, ImagePreview> = Object.create(null)
      let imageBytes = 0
      for (const ref of await parseImageReferences(source, format, path, modules)) {
        signal.throwIfAborted()
        if (!client.readImage || images[ref.key]) continue
        const pixels = await documentImage(await client.readImage(ref.path), signal)
        imageBytes += pixels.dataURL.length
        if (imageBytes > 20 * 1024 * 1024) throw new Error('The component images exceed the export preview limit.')
        images[ref.key] = pixels
      }
      const resources: Record<string, string> = Object.create(null)
      let resourceBytes = 0
      for (const text of [source, ...modules.map(module => module.esm)]) for (const ref of parseSourceRefs(text)) {
        signal.throwIfAborted()
        if (ref.kind === 'link' || resources[ref.path]) continue
        if (Object.keys(resources).length >= 64) throw new Error('The component drawing count exceeds the export preview limit.')
        const file = await client.read(ref.path)
        const svg = ref.kind === 'drawing' ? await drawingSvgForContent(file.content, ref.path)
          : await diagramSvgForWorkspace(file.content, ref.path, client)
        resourceBytes += svg.length
        if (resourceBytes > 16 * 1024 * 1024) throw new Error('The component drawings exceed the export preview limit.')
        resources[ref.path] = svg
      }
      if (live && !signal.aborted) setPrepared({environment, images, resources})
    })().catch(error => {if (live && !request.signal.aborted) request.reject(error instanceof Error ? error : new Error(String(error)))})
    return () => {live = false; controller.abort(); request.signal.removeEventListener('abort', cancel)}
  }, [request])
  useEffect(() => {
    if (!prepared) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const capture = () => {
      if (!live || request.signal.aborted) return
      if (!api.current) {timer = setTimeout(capture, 25); return}
      void api.current.exportSnapshot().then(islands => {
        if (live && !request.signal.aborted) request.resolve(islands)
      }, error => {if (live && !request.signal.aborted) request.reject(error instanceof Error ? error : new Error(String(error)))})
    }
    capture()
    return () => {live = false; clearTimeout(timer)}
  }, [prepared, request])
  if (!prepared) return null
  // A finite layout keeps charts and canvases sized without changing the
  // current reader, its focus, or any live embedded document.
  return <div aria-hidden="true" inert style={{position: 'fixed', left: -10000, top: 0, width: 900, height: 1000, pointerEvents: 'none'}}>
    <LazyRenderedEditor document={{text: request.source, revision: 0, format: request.format}}
      documentPath={request.path} documentId={request.id} readOnly active={false} apiRef={api}
      componentEnvironment={prepared.environment} imageResources={prepared.images} resources={prepared.resources}
      allowedResourcePaths={Object.keys(prepared.resources)} onPatch={() => false} errorBanner={false}
      onError={onError} />
  </div>
}

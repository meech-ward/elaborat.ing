import type { DocumentFormat } from '@/features/document'
import { isDocumentPath } from '@/features/document/documentPaths'
import { resolveImagePath } from '@/features/images/referencePaths'
import { projectPathProblem } from '@/features/project-storage/model'
import { zipProject } from '@/features/projects/projectArchive'
import type { WorkspaceFile, WorkspaceStore } from '@/features/workbench/workspaceStore'
import { resolveNoteLink } from '@/features/workbench/noteLinks'
import { createNotionAssets } from './notionAssets'
import { notionHtml, type NotionHtmlResult } from './notionHtml'
import { notionVector } from './notionVector'

export type NotionWorkspace = Pick<WorkspaceStore, 'read' | 'readImage' | 'readImageAsset'> & {
  /** Immutable bytes tied to a file revision, for a finite public bundle that
   * deliberately does not expose private Storage asset metadata. */
  readImageRevision?: (path: string, revision: string | null, preview?: boolean) => Promise<Blob>;
}
export type StaticIsland = {from: number; to: number; html: string}
export type SnapshotRequest = {path: string; source: string; format: DocumentFormat; client: NotionWorkspace}
export type NotionExportResult = {
  bytes: Uint8Array<ArrayBuffer>; filename: string; documentCount: number; assetCount: number;
  diagnostics: NotionHtmlResult['diagnostics'];
}
export type DocumentExportOptions = {
  path: string; source: string; client: NotionWorkspace; sources?: ReadonlyMap<string, string>;
  snapshot?: (request: SnapshotRequest) => Promise<StaticIsland[]>;
  projectFileUrl?: (path: string) => string | null;
  signal?: AbortSignal; onProgress?: (message: string) => void;
}
export type PreparedDocumentExport = {
  html: string; assets: Array<{path: string; bytes: Uint8Array}>; filenameStem: string;
  documentCount: number; assetCount: number; diagnostics: NotionHtmlResult['diagnostics'];
}

const encoder = new TextEncoder()
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function notionExportName(path: string): string {
  const stem = (path.split('/').at(-1) ?? 'document').replace(/\.mdx?$/i, '')
    .normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-').replace(/^\.+/, '').trim().slice(0, 120)
  return stem || 'document'
}

/** Reads are frozen once. Images use immutable asset IDs or a public bundle's
 * revision-bound reader, never a later replacement at the same path.
 * No export operation writes or saves a file.
 */
export function frozenNotionWorkspace(client: NotionWorkspace, sources: ReadonlyMap<string, string>, signal?: AbortSignal): NotionWorkspace {
  const files = new Map<string, Promise<WorkspaceFile>>()
  let textBytes = 0
  const read = (path: string) => {
    signal?.throwIfAborted()
    if (projectPathProblem(path)) return Promise.reject(new Error('This export reference is not a project file.'))
    let pending = files.get(path)
    if (!pending) {
      if (files.size >= 128) return Promise.reject(new Error('This export references more than 128 project files.'))
      pending = client.read(path).then(file => {
        signal?.throwIfAborted()
        const content = sources.get(path) ?? file.content
        textBytes += encoder.encode(content).byteLength
        if (textBytes > 8 * 1024 * 1024) throw new Error('The export source exceeds 8 MiB.')
        return {...file, content}
      })
      files.set(path, pending)
    }
    return pending
  }
  return {read, readImage: client.readImage ? async (path, preview) => {
    const file = await read(path)
    if (file.kind !== 'image') throw new Error('This export image is unavailable.')
    if (!file.asset) {
      if (!client.readImageRevision) throw new Error('This export image is unavailable.')
      const bytes = await client.readImageRevision(path, file.revision, preview)
      signal?.throwIfAborted()
      return bytes
    }
    if (client.readImageAsset) return client.readImageAsset(file.asset.id, preview)
    const bytes = await client.readImage!(path, preview)
    if ((await client.read(path)).asset?.id !== file.asset.id) throw new Error('An image changed during export. Prepare the export again.')
    signal?.throwIfAborted()
    return bytes
  } : undefined}
}

/** Portable exports share ordinary semantic HTML and validated local assets.
 * Its contents are generated locally; custom code runs only in the existing
 * isolated renderer supplied by the caller, never in this converter.
 */
export async function prepareDocumentExport(options: DocumentExportOptions): Promise<PreparedDocumentExport> {
  const {path, source, signal} = options
  if (!isDocumentPath(path)) throw new Error('Choose a Markdown or MDX note to export.')
  if (encoder.encode(source).byteLength > 2 * 1024 * 1024) throw new Error('This note exceeds the export source limit.')
  const sources = new Map(options.sources)
  sources.set(path, source)
  const client = frozenNotionWorkspace(options.client, sources, signal)
  const assets = createNotionAssets(client, signal)
  const converted = new Map<string, Promise<NotionHtmlResult>>()
  let instances = 0
  const convert = async (current: string, text: string, ancestors: readonly string[]): Promise<NotionHtmlResult> => {
    signal?.throwIfAborted()
    if (++instances > 64) throw new Error('This export includes more than 64 embedded document instances.')
    if (ancestors.includes(current) || ancestors.length > 4) throw new Error('An embedded document is circular or exceeds four nested levels.')
    const cached = converted.get(current)
    if (cached) return cached
    const next = [...ancestors, current]
    let snapshots: Promise<StaticIsland[]> | undefined
    const format: DocumentFormat = /\.mdx$/i.test(current) ? 'mdx' : 'md'
    const result = notionHtml({source: text, path: current, format, signal,
      resolveAsset: async ref => {
        options.onProgress?.(`Including ${ref.src}`)
        let packaged: string
        if (ref.kind === 'image') {
          const resolved = resolveImagePath(ref.sourcePath, ref.src)
          if (!resolved) throw new Error('Images must reference a file in this project.')
          packaged = await assets.image(resolved)
        } else {
          if (projectPathProblem(ref.src)) throw new Error('Choose a drawing or diagram in this project.')
          packaged = await (ref.kind === 'drawing' ? assets.drawing(ref.src) : assets.diagram(ref.src))
        }
        return {src: packaged, alt: ref.alt}
      },
      resolveDocument: async ref => {
        if (!isDocumentPath(ref.src)) throw new Error('Choose an embedded note in this project.')
        options.onProgress?.(`Including ${ref.src}`)
        return convert(ref.src, (await client.read(ref.src)).content, next)
      },
      raster: dataURL => assets.raster(dataURL),
      vector: svg => notionVector(svg, dataURL => assets.raster(dataURL), signal),
      snapshot: options.snapshot ? async ref => {
        options.onProgress?.(`Rendering ${current}`)
        snapshots ??= options.snapshot!({path: current, source: text, format, client})
        const island = (await snapshots).find(island => island.from === ref.from && island.to === ref.to)
        return island ? {html: island.html} : null
      } : undefined,
      rewriteLink: (href, owner) => {
        if (href.startsWith('#')) return href
        const target = resolveNoteLink(href, owner)
        if (target.kind === 'web') return target.url
        return target.kind === 'file' ? options.projectFileUrl?.(target.path) ?? null : null
      },
    })
    converted.set(current, result)
    return result
  }
  options.onProgress?.('Converting the document')
  const result = await convert(path, source, [])
  signal?.throwIfAborted()
  const title = notionExportName(path)
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><article>${result.html}</article></body></html>\n`
  if (encoder.encode(html).byteLength > 5 * 1024 * 1024) throw new Error('The converted HTML exceeds 5 MiB. Export a smaller document.')
  // createNotionAssets already owns a fresh byte copy for each asset. Keep
  // that ownership rather than doubling the full asset budget in memory.
  return {html, assets: assets.files.map(file => ({...file})), filenameStem: title,
    documentCount: converted.size, assetCount: assets.files.length, diagnostics: result.diagnostics}
}

/** A Notion package contains one HTML page and its adjacent asset copies. */
export async function buildNotionExport(options: DocumentExportOptions): Promise<NotionExportResult> {
  const result = await prepareDocumentExport(options)
  options.signal?.throwIfAborted()
  options.onProgress?.('Packing the Notion ZIP')
  const bytes = zipProject([{path: `${result.filenameStem}.html`, content: result.html}, ...result.assets.map(file => ({...file, content: ''}))], [])
  options.signal?.throwIfAborted()
  return {bytes, filename: `${result.filenameStem}-notion.zip`, documentCount: result.documentCount,
    assetCount: result.assetCount, diagnostics: result.diagnostics}
}

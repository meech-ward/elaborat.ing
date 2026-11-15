import { DEFAULT_APPEARANCE, getPaletteColors } from '../features/appearance/tokens'
import { exportDrawingSvg } from '../features/drawings/export'
import type { DrawingScene } from '../features/drawings/types'
import { compileD2Diagram } from '../features/structured/compiler'
import { presentDiagramElements } from '../features/structured/presentation'
import { readSidecarFile } from '../features/structured/structuredClient'
import { nativePathFor, projectDiagramArtifact } from '../features/workbench/diagramArtifact'
import { prepareSceneImages } from './images'
import {
  FULL_PREVIEW_REGION, MAX_PREVIEW_EDGE, MAX_PREVIEW_PIXELS, MAX_PREVIEW_PNG_BYTES,
  PREVIEW_PROFILE, parsePreviewJob, parsePreviewReply,
  type PreviewRegion, type PreviewRenderJob, type PreviewRenderReply,
} from './protocol'
import { checkPreviewValue, MAX_PREVIEW_SVG_CHARS, parsePreviewScene, PreviewFailure, validatePreviewScene } from './scene'

type Diagnostic = { code: string; message: string }
const limited = (text: string, length = 300) => text.length > length ? `${text.slice(0, length - 3)}...` : text

/** Pinned native export puts clip-path in the SVG namespace; XML images
 * require unnamespaced presentation attributes for frame/image clipping. */
export function repairPreviewSvgNamespaces(svg: SVGSVGElement): void {
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (attribute.namespaceURI !== 'http://www.w3.org/2000/svg') continue
      element.removeAttributeNS(attribute.namespaceURI, attribute.localName)
      element.setAttribute(attribute.localName, attribute.value)
    }
  }
}

export function previewViewport(viewBox: readonly number[], region: PreviewRegion) {
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) throw new PreviewFailure('render_failed', 'The native renderer returned invalid picture bounds.')
  return {
    x: viewBox[0] + region.x * viewBox[2], y: viewBox[1] + region.y * viewBox[3],
    width: region.width * viewBox[2], height: region.height * viewBox[3],
  }
}

export function previewDimensions(width: number, height: number, reduction = 1) {
  if (![width, height, reduction].every(value => Number.isFinite(value) && value > 0)) throw new PreviewFailure('render_failed', 'The picture has invalid output dimensions.')
  const scale = Math.min(2, MAX_PREVIEW_EDGE / Math.max(width, height), Math.sqrt(MAX_PREVIEW_PIXELS) / Math.sqrt(width) / Math.sqrt(height)) * reduction
  const pixelWidth = Math.max(1, Math.floor(width * scale)), pixelHeight = Math.max(1, Math.floor(height * scale))
  return { width: pixelWidth, height: pixelHeight, scale: Math.min(pixelWidth / width, pixelHeight / height) }
}

async function sceneFor(job: PreviewRenderJob, diagnostics: Diagnostic[]): Promise<{ scene: DrawingScene; regenerated: boolean }> {
  if (job.kind === 'drawing') return { scene: parsePreviewScene(job.source, job.path), regenerated: false }
  const nativePath = nativePathFor(job.path)
  const canvas = job.canvas === null ? null : parsePreviewScene(job.canvas, nativePath)
  if (job.layout !== null) {
    let layout: unknown
    try { layout = JSON.parse(job.layout) } catch { throw new PreviewFailure('invalid_input', 'The saved diagram layout record is invalid JSON.') }
    checkPreviewValue(layout)
    if (!readSidecarFile(job.layout)) throw new PreviewFailure('invalid_input', 'The saved diagram layout record is invalid.')
  }
  let regenerated = false
  const result = await projectDiagramArtifact({
    source: job.source,
    nativePath,
    // Parsing above has already bounded any compressed legacy payload.
    nativeContent: canvas === null ? null : JSON.stringify(canvas),
    sidecarContent: job.layout,
    compile: async () => {
      regenerated = true
      const compiled = await compileD2Diagram(job.source)
      return compiled.ok ? { diagram: compiled.diagram, error: null } : { diagram: null, error: compiled.error }
    },
  })
  for (const item of result.diagnostics) diagnostics.push({ code: limited(item.code, 80), message: limited(item.message) })
  for (const item of result.conflicts) diagnostics.push({ code: 'd2/merge-conflict', message: limited(item.message) })
  if (result.conflicts.length) {
    diagnostics.unshift({ code: 'd2/merge-conflict', message: `The diagram has ${result.conflicts.length} regeneration conflicts. Resolve them in elaborat.ing before visual verification.` })
    throw new PreviewFailure('d2_error', 'The diagram has regeneration conflicts. Resolve them in elaborat.ing before visual verification.')
  }
  if (!result.ok) throw new PreviewFailure('d2_error', result.diagnostics[0]?.message ?? 'The diagram source could not be compiled.')
  validatePreviewScene(result.scene)
  const palette = getPaletteColors({ ...DEFAULT_APPEARANCE, scheme: 'light' })
  return {
    scene: { ...result.scene, elements: presentDiagramElements(result.scene.elements, { stroke: palette.ink, label: palette.inkSoft, fill: palette.d2Fill, fill2: palette.d2Fill2 }) },
    regenerated,
  }
}

async function rasterize(svg: SVGSVGElement, viewport: ReturnType<typeof previewViewport>) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new PreviewFailure('render_failed', 'The browser has no picture renderer.')
  try {
    for (let attempt = 0; attempt < 18; attempt++) {
      const dimensions = previewDimensions(viewport.width, viewport.height, 0.8 ** attempt)
      canvas.width = dimensions.width
      canvas.height = dimensions.height
      svg.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`)
      svg.setAttribute('width', String(dimensions.width))
      svg.setAttribute('height', String(dimensions.height))
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }))
      const image = new Image()
      try {
        image.src = url
        await image.decode()
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, dimensions.width, dimensions.height)
        context.drawImage(image, 0, 0, dimensions.width, dimensions.height)
      } finally {
        image.src = ''
        URL.revokeObjectURL(url)
      }
      const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!png) throw new PreviewFailure('render_failed', 'The browser could not encode the preview.')
      if (png.size <= MAX_PREVIEW_PNG_BYTES) {
        const bytes = new Uint8Array(await png.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        return { png: btoa(binary), ...dimensions, reduced: attempt > 0 }
      }
      if (Math.max(dimensions.width, dimensions.height) <= 64) break
    }
    throw new PreviewFailure('limit', 'The picture could not fit the image budget. Request a smaller region.')
  } finally { canvas.width = 0; canvas.height = 0 }
}

/** Standalone browser entry: native export only, with no editor or account session. */
export async function renderAgentPreview(input: PreviewRenderJob): Promise<PreviewRenderReply> {
  const identity = { job_id: input.job_id, input_digest: input.input_digest, renderer_build: input.renderer_build }
  const diagnostics: Diagnostic[] = []
  try {
    const job = parsePreviewJob(input)
    const projected = await sceneFor(job, diagnostics)
    const prepared = await prepareSceneImages(projected.scene)
    if (prepared.flattened) diagnostics.push({ code: 'image/static', message: 'Embedded vector and animated images are shown as validated static pictures.' })
    if (prepared.scene.elements.some(element => element.type === 'embeddable' || element.type === 'iframe')) diagnostics.push({ code: 'embed/placeholder', message: 'External embedded pages are shown as native placeholders without fetching them.' })
    const scene = { ...prepared.scene, appState: { ...prepared.scene.appState, theme: 'light', exportWithDarkMode: false, exportEmbedScene: false, exportScale: 1 } }
    const source = await exportDrawingSvg(scene, { theme: 'light', padding: 10 })
    if (source.length > MAX_PREVIEW_SVG_CHARS) throw new PreviewFailure('limit', 'The native picture exceeds the SVG byte budget.')
    const document = new DOMParser().parseFromString(source, 'image/svg+xml')
    const svg = document.documentElement as unknown as SVGSVGElement
    if (svg.localName !== 'svg' || document.querySelector('parsererror')) throw new PreviewFailure('render_failed', 'The native renderer returned an invalid SVG.')
    repairPreviewSvgNamespaces(svg)
    const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    const region = job.region ?? FULL_PREVIEW_REGION
    const viewport = previewViewport(viewBox, region)
    const output = await rasterize(svg, viewport)
    if (output.reduced) diagnostics.push({ code: 'image/reduced', message: 'The preview resolution was reduced to fit the image budget. Request a smaller region for more detail.' })
    return parsePreviewReply({
      outcome: { ...identity, status: 'ready', profile: PREVIEW_PROFILE,
        rendered_from: job.kind === 'drawing' ? 'saved_scene' : 'projected_diagram', regenerated: projected.regenerated,
        view_box: viewBox, region, pixel_width: output.width, pixel_height: output.height, scale: output.scale,
        diagnostics: diagnostics.slice(0, 10),
      }, png: output.png,
    }, job)
  } catch (error) {
    return { outcome: { ...identity, status: 'error', code: error instanceof PreviewFailure ? error.code : 'render_failed', message: limited(error instanceof Error ? error.message : 'The picture could not be rendered.'), diagnostics: diagnostics.slice(0, 10) } }
  }
}

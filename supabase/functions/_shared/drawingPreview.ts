import { z } from 'zod/mini'
import {
  MAX_PREVIEW_BASE64_CHARS,
  MAX_PREVIEW_D2_BYTES,
  MAX_PREVIEW_FILE_BYTES,
  MAX_PREVIEW_PNG_BYTES,
  PREVIEW_PROFILE,
  parsePreviewJob,
  parsePreviewReply,
  type PreviewRenderJob,
  type PreviewRenderReply,
} from '../../../src/agent-preview/protocol.ts'
import { inspectImage } from '../../../src/features/images/format.ts'

const encoder = new TextEncoder()
export type DrawingPreviewFailureCode = 'missing' | 'unsupported' | 'invalid_input' | 'conflict' | 'unavailable' |
  'rate_limit' | 'render_failed' | 'limit' | 'cancelled' | 'empty' | 'd2_error'
export class DrawingPreviewFailure extends Error {
  constructor(readonly code: DrawingPreviewFailureCode, message: string, readonly retryAfter?: number) { super(message) }
}

export const drawingPreviewPathSchema = z.string().check(z.minLength(1), z.maxLength(1024), z.refine(value =>
  encoder.encode(value).length <= 1024 && value.normalize('NFC') === value &&
  !/(^\/|\/$|\/\/|(^|\/)\.|[\\:\u0000-\u001f\u007f-\u009f])/.test(value),
  'The path is not a valid project path.'))
export const drawingPreviewRowSchema = z.strictObject({
  id: z.uuid(), path: drawingPreviewPathSchema, kind: z.enum(['text', 'image']),
  content: z.string().check(z.maxLength(MAX_PREVIEW_FILE_BYTES), z.refine(value => encoder.encode(value).length <= MAX_PREVIEW_FILE_BYTES)),
  version: z.int().check(z.minimum(1)),
})
export type DrawingPreviewRow = z.infer<typeof drawingPreviewRowSchema>
export type DrawingPreviewInput = { path: string; id: string | null; version: number | null; sha256: string | null }

export function drawingPreviewPaths(path: string): { kind: 'drawing' | 'diagram'; paths: string[] } {
  if (!drawingPreviewPathSchema.safeParse(path).success) throw new DrawingPreviewFailure('invalid_input', 'The saved file path is invalid.')
  if (/\.d2$/i.test(path)) return { kind: 'diagram', paths: [path, path.replace(/\.d2$/i, '.excalidraw'), `${path}.json`] }
  if (/\.excalidraw(?:\.md)?$/i.test(path)) return { kind: 'drawing', paths: [path] }
  throw new DrawingPreviewFailure('unsupported', 'Visual previews support Excalidraw drawings and D2 diagrams.')
}

export async function drawingPreviewDigest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Exact saved bytes, stable companion order, and explicit absent companions. */
export async function createPreviewSnapshot(rawRows: readonly unknown[], rendererBuild: string,
  profile: string = PREVIEW_PROFILE, rootPath?: string) {
  const parsed = z.array(drawingPreviewRowSchema).check(z.maxLength(3)).safeParse(rawRows)
  if (!parsed.success) throw new DrawingPreviewFailure('limit', 'The saved preview inputs are invalid or exceed the supported limits.')
  const path = rootPath ?? parsed.data[0]?.path
  if (!path) throw new DrawingPreviewFailure('missing', 'The saved preview file is missing.')
  const { kind, paths } = drawingPreviewPaths(path)
  const rows = new Map(parsed.data.map(row => [row.path, row]))
  if (rows.size !== parsed.data.length || parsed.data.some(row => !paths.includes(row.path)))
    throw new DrawingPreviewFailure('render_failed', 'The saved preview inputs could not be verified.')
  const root = rows.get(path)
  if (!root) throw new DrawingPreviewFailure('missing', 'The saved preview file is missing.')
  if (parsed.data.some(row => row.kind !== 'text')) throw new DrawingPreviewFailure('unsupported', 'A drawing or diagram input is not a text file.')
  if (kind === 'diagram' && encoder.encode(root.content).length > MAX_PREVIEW_D2_BYTES)
    throw new DrawingPreviewFailure('limit', 'Diagram previews support at most 64 KiB of D2 source.')
  const manifest: DrawingPreviewInput[] = await Promise.all(paths.map(async path => {
    const row = rows.get(path)
    return { path, id: row?.id ?? null, version: row?.version ?? null, sha256: row ? await drawingPreviewDigest(row.content) : null }
  }))
  const snapshot = await drawingPreviewDigest(JSON.stringify({ inputs: manifest, renderer_build: rendererBuild, profile }))
  return { kind, root, rows, paths, manifest, snapshot }
}
export type DrawingPreviewSnapshot = Awaited<ReturnType<typeof createPreviewSnapshot>>

export function createPreviewRenderJob(snapshot: DrawingPreviewSnapshot, rendererBuild: string, jobId = crypto.randomUUID()): PreviewRenderJob {
  try {
    return parsePreviewJob({ job_id: jobId, input_digest: snapshot.snapshot, renderer_build: rendererBuild,
      profile: PREVIEW_PROFILE, kind: snapshot.kind, path: snapshot.root.path, source: snapshot.root.content,
      canvas: snapshot.kind === 'diagram' ? snapshot.rows.get(snapshot.paths[1])?.content ?? null : null,
      layout: snapshot.kind === 'diagram' ? snapshot.rows.get(snapshot.paths[2])?.content ?? null : null,
      region: null })
  } catch { throw new DrawingPreviewFailure('limit', 'The saved inputs exceed the visual preview limits.') }
}

export interface PreviewServiceConfig { secret: string; endpoint: string; fetcher?: typeof fetch }

/** Service identity only. User and database credentials never enter a browser job. */
export async function renderPreviewThroughWorker(job: PreviewRenderJob, signal?: AbortSignal,
  supplied?: PreviewServiceConfig): Promise<PreviewRenderReply> {
  const secret = supplied?.secret ?? Deno.env.get('AGENT_PREVIEW_SECRET')?.trim()
  const configured = supplied?.endpoint ?? Deno.env.get('AGENT_PREVIEW_ENDPOINT')?.trim() ?? 'https://elaborat.ing/_agent-preview'
  if (!secret) throw new DrawingPreviewFailure('unavailable', 'Visual previews are not configured for this installation.')
  let endpoint: URL
  try { endpoint = new URL(configured) } catch { throw new DrawingPreviewFailure('unavailable', 'The visual preview service is unavailable.') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new DrawingPreviewFailure('unavailable', 'The visual preview service is unavailable.')
  let response: Response
  try {
    response = await (supplied?.fetcher ?? fetch)(endpoint, { method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(job), redirect: 'error', signal })
  } catch {
    if (signal?.aborted) throw new DrawingPreviewFailure('cancelled', 'The visual preview request timed out or was cancelled.')
    throw new DrawingPreviewFailure('unavailable', 'The visual preview service could not be reached. Try again.')
  }
  if (response.status === 429) {
    const raw = response.headers.get('retry-after')
    const seconds = raw && /^\d{1,6}$/.test(raw) ? Math.max(1, Math.min(86400, Number(raw))) : undefined
    await response.body?.cancel()
    throw new DrawingPreviewFailure('rate_limit', 'The visual preview service is busy or has reached its usage limit. Try again later.', seconds)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new DrawingPreviewFailure('unavailable', 'The visual preview service could not complete this request. Try again.')
  }
  const maxBytes = MAX_PREVIEW_BASE64_CHARS + 16_384
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel()
    throw new DrawingPreviewFailure('limit', 'The visual preview service returned an oversized result.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new DrawingPreviewFailure('render_failed', 'The visual preview service returned no result.')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new DrawingPreviewFailure('cancelled', 'The visual preview request timed out or was cancelled.')
      const part = await reader.read()
      if (part.done) break
      if ((total += part.value.byteLength) > maxBytes) throw new DrawingPreviewFailure('limit', 'The visual preview service returned an oversized result.')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return parsePreviewReply(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), job) }
  catch { throw new DrawingPreviewFailure('render_failed', 'The visual preview service returned an invalid result.') }
}

// Photon retains its WASM high-water mark. Decode bounded output serially.
let decoding = Promise.resolve()
export async function verifyPreviewPng(encoded: string, width: number, height: number): Promise<Uint8Array> {
  if (encoded.length > MAX_PREVIEW_BASE64_CHARS) throw new DrawingPreviewFailure('limit', 'The visual preview exceeds its transport limit.')
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)) }
  catch { throw new DrawingPreviewFailure('render_failed', 'The visual preview image is invalid.') }
  if (bytes.byteLength > MAX_PREVIEW_PNG_BYTES) throw new DrawingPreviewFailure('limit', 'The visual preview exceeds its image limit.')
  try {
    const info = inspectImage(bytes, 'image/png', MAX_PREVIEW_PNG_BYTES)
    if (info.mediaType !== 'image/png' || info.width !== width || info.height !== height || info.animated) throw new Error('dimensions')
  } catch { throw new DrawingPreviewFailure('render_failed', 'The visual preview image could not be verified.') }
  const previous = decoding
  let release!: () => void
  decoding = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    const { PhotonImage } = await import('npm:@cf-wasm/photon@0.4.0/node')
    const image = PhotonImage.new_from_byteslice(bytes)
    try {
      if (image.get_width() !== width || image.get_height() !== height) throw new Error('dimensions')
    } finally { image.free() }
  } catch { throw new DrawingPreviewFailure('render_failed', 'The visual preview image could not be decoded.') }
  finally { release() }
  return bytes
}

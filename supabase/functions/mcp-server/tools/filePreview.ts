import type { CallToolResult, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import { z } from 'zod/mini'
import { z as mcpZod } from 'npm:zod@4.4.3'

import {
  MAX_PREVIEW_BASE64_CHARS,
  MAX_PREVIEW_D2_BYTES,
  MAX_PREVIEW_FILE_BYTES,
  MAX_PREVIEW_PNG_BYTES,
  MAX_PREVIEW_RESULT_CHARS,
  parsePreviewJob,
  parsePreviewReply,
  PREVIEW_PROFILE,
  PREVIEW_TIMEOUT_MS,
  previewRegionSchema,
  type PreviewRenderer,
  type PreviewRenderJob,
  type PreviewRenderReply,
} from '../../../../src/agent-preview/protocol.ts'
import { inspectImage } from '../../../../src/features/images/format.ts'
import { PREVIEW_BUILD } from './previewManifest.ts'
import type { ToolContext } from './types.ts'

const encoder = new TextEncoder()
const version = z.int().check(z.minimum(1))
const digest = z.string().check(z.regex(/^[a-f0-9]{64}$/))
const projectPath = z.string().check(z.minLength(1), z.maxLength(1024), z.refine(value =>
  encoder.encode(value).length <= 1024 && value.normalize('NFC') === value &&
  !/(^\/|\/$|\/\/|(^|\/)\.|[\\:\u0000-\u001f\u007f-\u009f])/.test(value),
  'The path is not a valid project path.'))

export const filePreviewInputSchema = z.strictObject({
  project_id: z.uuid(),
  path: projectPath,
  expected_version: z.optional(version),
  expected_snapshot: z.optional(digest),
  region: z.optional(previewRegionSchema),
}).check(z.refine(input => input.region === undefined || input.expected_snapshot !== undefined,
  'A detail region requires the snapshot returned with its overview.'))
export type FilePreviewInput = z.infer<typeof filePreviewInputSchema>

// The pinned MCP SDK's schema adapter supports full Zod. Keep the shared
// browser boundary on mini and validate again in the independently callable payload.
const mcpInputSchema = mcpZod.strictObject({
  project_id: mcpZod.uuid(),
  path: mcpZod.string().min(1).max(1024).refine(value => projectPath.safeParse(value).success),
  expected_version: mcpZod.number().int().positive().optional(),
  expected_snapshot: mcpZod.string().regex(/^[a-f0-9]{64}$/).optional(),
  region: mcpZod.strictObject({
    x: mcpZod.number().min(0).max(1),
    y: mcpZod.number().min(0).max(1),
    width: mcpZod.number().positive().max(1),
    height: mcpZod.number().positive().max(1),
  }).refine(region => region.x + region.width <= 1 && region.y + region.height <= 1).optional(),
}).refine(input => input.region === undefined || input.expected_snapshot !== undefined,
  'A detail region requires the snapshot returned with its overview.')

const fileRowSchema = z.strictObject({
  id: z.uuid(),
  path: projectPath,
  kind: z.enum(['text', 'image']),
  content: z.string().check(z.maxLength(MAX_PREVIEW_FILE_BYTES), z.refine(value => encoder.encode(value).length <= MAX_PREVIEW_FILE_BYTES)),
  version,
})
type InputManifest = { path: string; id: string | null; version: number | null; sha256: string | null }
type FailureCode = 'missing' | 'unsupported' | 'invalid_input' | 'conflict' | 'unavailable' | 'rate_limit' | 'render_failed' | 'limit' | 'cancelled' | 'empty' | 'd2_error'

class PreviewFailure extends Error {
  constructor(readonly code: FailureCode, message: string, readonly retryAfter?: number) {
    super(message)
  }
}

const urlFor = (projectId: string, path: string) =>
  `https://elaborat.ing/projects/${projectId}/${path.split('/').map(encodeURIComponent).join('/')}`

function failed(code: FailureCode, message: string, url: string, retryAfter?: number): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${message} Open in elaborat.ing: ${url}` }],
    structuredContent: { status: 'error', code, message, url, ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}) },
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function previewKind(path: string): 'drawing' | 'diagram' | null {
  if (/\.d2$/i.test(path)) return 'diagram'
  return /\.excalidraw(?:\.md)?$/i.test(path) ? 'drawing' : null
}

/** Freeze the exact root and companions in a single caller-scoped statement. */
async function readSnapshot(supabase: SupabaseClient, input: FilePreviewInput, signal: AbortSignal) {
  const kind = previewKind(input.path)
  if (!kind) throw new PreviewFailure('unsupported', 'Visual previews support Excalidraw drawings and D2 diagrams.')
  const paths = kind === 'diagram'
    ? [input.path, input.path.replace(/\.d2$/i, '.excalidraw'), `${input.path}.json`]
    : [input.path]
  const { data, error } = await supabase.from('project_files')
    .select('id,path,kind,content,version')
    .eq('project_id', input.project_id)
    .in('path', paths)
    .abortSignal(signal)
  if (error) throw new PreviewFailure('unavailable', 'The saved file could not be read. Try again.')
  const parsed = z.array(fileRowSchema).check(z.maxLength(3)).safeParse(data)
  if (!parsed.success) throw new PreviewFailure('limit', 'The saved preview inputs are invalid or exceed the supported limits.')
  const rows = new Map(parsed.data.map(row => [row.path, row]))
  if (rows.size !== parsed.data.length || parsed.data.some(row => !paths.includes(row.path))) {
    throw new PreviewFailure('render_failed', 'The saved preview inputs could not be verified.')
  }
  const root = rows.get(input.path)
  if (!root) throw new PreviewFailure('missing', 'That saved file is missing or inaccessible.')
  if (kind === 'diagram' && encoder.encode(root.content).length > MAX_PREVIEW_D2_BYTES) throw new PreviewFailure('limit', 'Diagram previews support at most 64 KiB of D2 source.')
  if (parsed.data.some(row => row.kind !== 'text')) throw new PreviewFailure('unsupported', 'A drawing or diagram input is not a text file.')
  if (input.expected_version !== undefined && root.version !== input.expected_version) {
    throw new PreviewFailure('conflict', `The saved file is version ${root.version}, which differs from the requested version.`)
  }
  const manifest: InputManifest[] = await Promise.all(paths.map(async path => {
    const row = rows.get(path)
    return { path, id: row?.id ?? null, version: row?.version ?? null, sha256: row ? await sha256(row.content) : null }
  }))
  const snapshot = await sha256(JSON.stringify({ inputs: manifest, renderer_build: PREVIEW_BUILD, profile: PREVIEW_PROFILE }))
  if (input.expected_snapshot !== undefined && input.expected_snapshot !== snapshot) {
    throw new PreviewFailure('conflict', 'The saved inputs or renderer changed since that preview. Request a new overview.')
  }
  return { kind, root, rows, paths, manifest, snapshot }
}

/** No caller credentials or provider errors cross this boundary. */
export async function renderPreviewThroughWorker(job: PreviewRenderJob, signal?: AbortSignal): Promise<PreviewRenderReply> {
  const secret = Deno.env.get('AGENT_PREVIEW_SECRET')?.trim()
  const configured = Deno.env.get('AGENT_PREVIEW_ENDPOINT')?.trim() || 'https://elaborat.ing/_agent-preview'
  if (!secret) throw new PreviewFailure('unavailable', 'Visual previews are not configured for this installation.')
  let endpoint: URL
  try { endpoint = new URL(configured) } catch { throw new PreviewFailure('unavailable', 'The visual preview service is unavailable.') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new PreviewFailure('unavailable', 'The visual preview service is unavailable.')
  }
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
      redirect: 'error',
      signal,
    })
  } catch {
    if (signal?.aborted) throw new PreviewFailure('cancelled', 'The visual preview request timed out or was cancelled.')
    throw new PreviewFailure('unavailable', 'The visual preview service could not be reached. Try again.')
  }
  if (response.status === 429) {
    const raw = response.headers.get('retry-after')
    const seconds = raw && /^\d{1,6}$/.test(raw) ? Math.max(1, Math.min(86400, Number(raw))) : undefined
    await response.body?.cancel()
    throw new PreviewFailure('rate_limit', 'The visual preview service is busy or has reached its usage limit. Try again later.', seconds)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new PreviewFailure('unavailable', 'The visual preview service could not complete this request. Try again.')
  }
  // Bound the whole response before JSON parsing; a header is only a hint.
  const maxBytes = MAX_PREVIEW_BASE64_CHARS + 16_384
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel()
    throw new PreviewFailure('limit', 'The visual preview service returned an oversized result.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new PreviewFailure('render_failed', 'The visual preview service returned no result.')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new PreviewFailure('limit', 'The visual preview service returned an oversized result.')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return parsePreviewReply(JSON.parse(new TextDecoder().decode(bytes)), job) }
  catch { throw new PreviewFailure('render_failed', 'The visual preview service returned an invalid result.') }
}

// Photon retains its WASM high-water mark. Validate one bounded raster at a time.
let decoding = Promise.resolve()
async function verifyPng(encoded: string, width: number, height: number): Promise<void> {
  if (encoded.length > MAX_PREVIEW_BASE64_CHARS) throw new PreviewFailure('limit', 'The visual preview exceeds its transport limit.')
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)) }
  catch { throw new PreviewFailure('render_failed', 'The visual preview image is invalid.') }
  if (bytes.byteLength > MAX_PREVIEW_PNG_BYTES) throw new PreviewFailure('limit', 'The visual preview exceeds its image limit.')
  try {
    const info = inspectImage(bytes, 'image/png', MAX_PREVIEW_PNG_BYTES)
    if (info.width !== width || info.height !== height || info.animated) throw new Error('dimensions')
  } catch { throw new PreviewFailure('render_failed', 'The visual preview image could not be verified.') }
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
  } catch { throw new PreviewFailure('render_failed', 'The visual preview image could not be decoded.') }
  finally { release() }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new PreviewFailure('cancelled', 'The visual preview request timed out or was cancelled.'))
    }
    // Always observe work, even when it was cancelled synchronously while
    // starting, so a later renderer rejection cannot become unhandled.
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function requireReadableRoot(supabase: SupabaseClient, projectId: string, fileId: string, signal: AbortSignal) {
  const current = await supabase.from('project_files').select('id')
    .eq('project_id', projectId).eq('id', fileId).abortSignal(signal).maybeSingle()
  if (current.error || !current.data || current.data.id !== fileId) {
    throw new PreviewFailure('missing', 'That saved file is missing or inaccessible.')
  }
  if (signal.aborted) throw new PreviewFailure('cancelled', 'The visual preview request timed out or was cancelled.')
}

export async function filePreviewPayload(
  { supabase }: ToolContext,
  rawInput: FilePreviewInput,
  renderer: PreviewRenderer = renderPreviewThroughWorker,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const url = urlFor(rawInput.project_id, rawInput.path)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(cancel, PREVIEW_TIMEOUT_MS)
  try {
    const validated = filePreviewInputSchema.safeParse(rawInput)
    if (!validated.success) throw new PreviewFailure('invalid_input', 'The preview arguments are invalid. A detail region requires its overview snapshot.')
    if (controller.signal.aborted) throw new PreviewFailure('cancelled', 'The visual preview request was cancelled.')
    const input = validated.data
    const snapshot = await abortable(readSnapshot(supabase, input, controller.signal), controller.signal)
    let job: PreviewRenderJob
    try { job = parsePreviewJob({
      job_id: crypto.randomUUID(),
      input_digest: snapshot.snapshot,
      renderer_build: PREVIEW_BUILD,
      profile: PREVIEW_PROFILE,
      kind: snapshot.kind,
      path: input.path,
      source: snapshot.root.content,
      canvas: snapshot.kind === 'diagram' ? snapshot.rows.get(snapshot.paths[1])?.content ?? null : null,
      layout: snapshot.kind === 'diagram' ? snapshot.rows.get(snapshot.paths[2])?.content ?? null : null,
      region: input.region ?? null,
    }) } catch { throw new PreviewFailure('limit', 'The saved inputs exceed the visual preview limits.') }
    const reply = parsePreviewReply(await abortable(renderer(job, controller.signal), controller.signal), job)
    if (controller.signal.aborted) throw new PreviewFailure('cancelled', 'The visual preview request timed out or was cancelled.')
    const outcome = reply.outcome
    if (outcome.status === 'error') {
      // Compile diagnostics can quote private source, so they need the same
      // post-render authorization check as image pixels.
      await requireReadableRoot(supabase, input.project_id, snapshot.root.id, controller.signal)
      return {
        ...failed(outcome.code, outcome.message, url),
        structuredContent: { status: 'error', code: outcome.code, message: outcome.message, diagnostics: outcome.diagnostics, url },
      }
    }
    if (!('png' in reply)) throw new PreviewFailure('render_failed', 'The visual preview service returned no image.')
    await abortable(verifyPng(reply.png, outcome.pixel_width, outcome.pixel_height), controller.signal)
    if (controller.signal.aborted) throw new PreviewFailure('cancelled', 'The visual preview request timed out or was cancelled.')
    // Authorization can change during browser work. The same user-scoped read
    // checks it again; a deleted/replaced root is not an implicit history read.
    await requireReadableRoot(supabase, input.project_id, snapshot.root.id, controller.signal)
    const result: CallToolResult = {
      content: [
        { type: 'text', text: `Visual preview of ${input.path}, saved version ${snapshot.root.version}. Open in elaborat.ing: ${url}` },
        { type: 'image', data: reply.png, mimeType: 'image/png' },
      ],
      structuredContent: {
        project_id: input.project_id,
        path: input.path,
        file_id: snapshot.root.id,
        version: snapshot.root.version,
        snapshot: snapshot.snapshot,
        inputs: snapshot.manifest,
        renderer_build: PREVIEW_BUILD,
        profile: PREVIEW_PROFILE,
        rendered_from: outcome.rendered_from,
        regenerated: outcome.regenerated,
        view_box: outcome.view_box,
        region: outcome.region,
        pixel_width: outcome.pixel_width,
        pixel_height: outcome.pixel_height,
        scale: outcome.scale,
        diagnostics: outcome.diagnostics,
        url,
      },
    }
    if (JSON.stringify(result).length > MAX_PREVIEW_RESULT_CHARS) throw new PreviewFailure('limit', 'The complete visual preview exceeds its transport limit.')
    return result
  } catch (error) {
    if (error instanceof PreviewFailure) return failed(error.code, error.message, url, error.retryAfter)
    if (controller.signal.aborted) return failed('cancelled', 'The visual preview request timed out or was cancelled.', url)
    return failed('render_failed', 'The visual preview could not be completed safely. Try again.', url)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}

export function registerFilePreview(server: McpServer, context: ToolContext, renderer?: PreviewRenderer): void {
  server.registerTool('get_file_preview', {
    title: 'Inspect drawing',
    description: 'Read a rendered PNG of a saved Excalidraw drawing or D2 diagram. Returns pixels, exact input versions and a snapshot identifier. An optional normalized detail region requires its overview snapshot. Rendering never saves files.',
    inputSchema: mcpInputSchema,
    annotations: { title: 'Inspect drawing', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (input, ctx) => filePreviewPayload(context, input, renderer, ctx.mcpReq.signal))
}

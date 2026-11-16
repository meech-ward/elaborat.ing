import type { CallToolResult, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import { z } from 'zod/mini'
import { z as mcpZod } from 'npm:zod@4.4.3'
import {
  FULL_PREVIEW_REGION, MAX_PREVIEW_BASE64_CHARS, MAX_PREVIEW_PNG_BYTES,
  MAX_PREVIEW_RESULT_CHARS, PREVIEW_PROFILE, PREVIEW_TIMEOUT_MS,
  previewReadySchema, previewRegionSchema, previewErrorSchema,
  type PreviewRegion,
} from '../../../../src/agent-preview/protocol.ts'
import { DrawingPreviewFailure, drawingPreviewPaths, verifyPreviewPng } from '../../_shared/drawingPreview.ts'
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

const storedMetadata = z.strictObject({
  snapshot: digest,
  inputs: z.array(z.strictObject({
    path: projectPath, id: z.nullable(z.uuid()), version: z.nullable(version), sha256: z.nullable(digest),
  }).check(z.refine(input => input.id === null
    ? input.version === null && input.sha256 === null
    : input.version !== null && input.sha256 !== null))).check(z.maxLength(3), z.minLength(1)),
  renderer_build: z.string().check(z.regex(/^[a-f0-9]{16}$/)),
  profile: z.literal(PREVIEW_PROFILE),
  outcome: z.union([previewReadySchema, previewErrorSchema]),
})
const storedRow = z.object({
  file_version: version,
  generation: z.int().check(z.minimum(1)),
  status: z.enum(['pending', 'ready', 'error']),
  metadata: z.nullable(storedMetadata),
  png: z.nullable(z.string().check(z.maxLength(MAX_PREVIEW_PNG_BYTES * 2 + 2))),
  error_code: z.nullable(z.string().check(z.maxLength(80))),
  message: z.nullable(z.string().check(z.maxLength(300))),
})
const rootRow = z.object({
  id: z.uuid(), path: projectPath, kind: z.enum(['text', 'image']), version,
  drawing_previews: z.union([storedRow, z.array(storedRow).check(z.maxLength(1)), z.null()]),
})
type FailureCode = 'missing' | 'unsupported' | 'invalid_input' | 'conflict' | 'unavailable' | 'render_failed' | 'limit' | 'cancelled'
class PreviewFailure extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message) }
}
const urlFor = (projectId: string, path: string) =>
  `https://elaborat.ing/projects/${projectId}/${path.split('/').map(encodeURIComponent).join('/')}`
function failed(code: string, message: string, url: string, diagnostics?: unknown, retryAfter?: number): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${message} Open in elaborat.ing: ${url}` }],
    structuredContent: { status: 'error', code, message, url, ...(diagnostics ? { diagnostics } : {}),
      ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}) },
  }
}
function base64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  return btoa(text)
}
function fromBytea(value: string): string {
  if (!/^\\x(?:[a-fA-F0-9]{2})+$/.test(value)) throw new PreviewFailure('render_failed', 'The stored preview image is invalid.')
  const bytes = new Uint8Array((value.length - 2) / 2)
  if (bytes.length > MAX_PREVIEW_PNG_BYTES) throw new PreviewFailure('limit', 'The stored preview exceeds its byte limit.')
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.slice(index * 2 + 2, index * 2 + 4), 16)
  return base64(bytes)
}

// One bounded decode/crop at a time keeps Photon's WASM high-water mark small.
let decoding = Promise.resolve()
async function pixels(encoded: string, width: number, height: number, region?: PreviewRegion) {
  const previous = decoding
  let release!: () => void
  decoding = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    const bytes = await verifyPreviewPng(encoded, width, height)
    if (!region || JSON.stringify(region) === JSON.stringify(FULL_PREVIEW_REGION))
      return { png: encoded, width, height }
    // This is a crop of existing pixels, never a native drawing/layout render.
    const { PhotonImage, crop } = await import('npm:@cf-wasm/photon@0.4.0/node')
    const image = PhotonImage.new_from_byteslice(bytes)
    try {
      const left = Math.min(width - 1, Math.floor(region.x * width))
      const top = Math.min(height - 1, Math.floor(region.y * height))
      const right = Math.min(width, Math.max(left + 1, Math.ceil((region.x + region.width) * width)))
      const bottom = Math.min(height, Math.max(top + 1, Math.ceil((region.y + region.height) * height)))
      const cropped = crop(image, left, top, right, bottom)
      try {
        const result = cropped.get_bytes()
        if (result.length > MAX_PREVIEW_PNG_BYTES) throw new PreviewFailure('limit', 'The stored preview crop exceeds its byte limit.')
        return { png: base64(result), width: cropped.get_width(), height: cropped.get_height() }
      } finally { cropped.free() }
    } finally { image.free() }
  } finally { release() }
}
async function requireReadableRoot(supabase: SupabaseClient, projectId: string, fileId: string, signal: AbortSignal) {
  const current = await supabase.from('project_files').select('id')
    .eq('project_id', projectId).eq('id', fileId).abortSignal(signal).maybeSingle()
  if (signal.aborted) throw new PreviewFailure('cancelled', 'The preview read was cancelled.')
  if (current.error || !current.data || current.data.id !== fileId)
    throw new PreviewFailure('missing', 'That saved file is missing or inaccessible.')
}

/** Read only: no renderer, queue mutation, network fetch or job wake happens here. */
export async function filePreviewPayload(
  { supabase }: ToolContext,
  rawInput: FilePreviewInput,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const url = urlFor(rawInput.project_id, rawInput.path)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(cancel, PREVIEW_TIMEOUT_MS)
  try {
    const parsedInput = filePreviewInputSchema.safeParse(rawInput)
    if (!parsedInput.success) throw new PreviewFailure('invalid_input', 'The preview arguments are invalid. A crop requires its overview snapshot.')
    const input = parsedInput.data
    if (!/\.(?:excalidraw(?:\.md)?|d2)$/i.test(input.path))
      throw new PreviewFailure('unsupported', 'Stored previews support Excalidraw drawings and D2 diagrams.')
    if (controller.signal.aborted) throw new PreviewFailure('cancelled', 'The preview read was cancelled.')
    // A single PostgREST statement freezes the root and its RLS-scoped artifact.
    const { data, error } = await supabase.from('project_files')
      .select('id,path,kind,version,drawing_previews(file_version,generation,status,png,metadata,error_code,message)')
      .eq('project_id', input.project_id).eq('path', input.path)
      .abortSignal(controller.signal).maybeSingle()
    if (controller.signal.aborted) throw new PreviewFailure('cancelled', 'The preview read was cancelled.')
    if (error) throw new PreviewFailure('unavailable', 'The stored preview could not be read. Try again.')
    if (!data) throw new PreviewFailure('missing', 'That saved file is missing or inaccessible.')
    const root = rootRow.parse(data)
    if (root.path !== input.path || root.kind !== 'text') throw new PreviewFailure('unsupported', 'The saved file is not a drawing or diagram source.')
    if (input.expected_version !== undefined && root.version !== input.expected_version)
      throw new PreviewFailure('conflict', `The saved file is version ${root.version}, which differs from the requested version.`)
    const row = Array.isArray(root.drawing_previews) ? root.drawing_previews[0] : root.drawing_previews
    if (!row || row.status === 'pending' || row.file_version !== root.version) {
      if (input.expected_snapshot !== undefined) throw new PreviewFailure('conflict', 'The saved inputs changed or their preview is still preparing. Request a new overview.')
      return {
        content: [{ type: 'text', text: `The preview of ${input.path}, saved version ${root.version}, is preparing in the background. Try again shortly. Open in elaborat.ing: ${url}` }],
        structuredContent: { status: 'pending', code: 'preparing', project_id: input.project_id, path: input.path, file_id: root.id, version: root.version, retry_after: 5, url },
      }
    }
    const meta = row.metadata
    if (input.expected_snapshot !== undefined && meta?.snapshot !== input.expected_snapshot)
      throw new PreviewFailure('conflict', 'The saved inputs or preview changed. Request a new overview.')
    if (row.status === 'error') {
      await requireReadableRoot(supabase, input.project_id, root.id, controller.signal)
      const outcome = meta?.outcome
      const now = new Date()
      const retryAfter = row.error_code === 'daily_limit'
        ? Math.max(1, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000))
        : undefined
      return failed(row.error_code ?? 'render_failed', row.message ?? 'The saved drawing preview could not be prepared.', url,
        outcome?.status === 'error' ? outcome.diagnostics : undefined, retryAfter)
    }
    if (!meta || !row.png || meta.outcome.status !== 'ready' || meta.outcome.input_digest !== meta.snapshot ||
      meta.outcome.renderer_build !== meta.renderer_build || meta.outcome.profile !== meta.profile ||
      JSON.stringify(meta.outcome.region) !== JSON.stringify(FULL_PREVIEW_REGION))
      throw new PreviewFailure('render_failed', 'The stored preview metadata is invalid.')
    const rootInput = meta.inputs[0]
    const expected = drawingPreviewPaths(root.path)
    if (rootInput.id !== root.id || rootInput.path !== root.path || rootInput.version !== root.version)
      throw new PreviewFailure('render_failed', 'The stored preview belongs to different saved inputs.')
    if (JSON.stringify(meta.inputs.map(input => input.path)) !== JSON.stringify(expected.paths) ||
      meta.outcome.rendered_from !== (expected.kind === 'diagram' ? 'projected_diagram' : 'saved_scene'))
      throw new PreviewFailure('render_failed', 'The stored preview input manifest is invalid.')
    const outcome = meta.outcome
    const image = await pixels(fromBytea(row.png), outcome.pixel_width, outcome.pixel_height, input.region)
    if (image.png.length > MAX_PREVIEW_BASE64_CHARS) throw new PreviewFailure('limit', 'The preview exceeds its transport limit.')
    await requireReadableRoot(supabase, input.project_id, root.id, controller.signal)
    const result: CallToolResult = {
      content: [
        { type: 'text', text: `${input.region ? 'Crop of the stored preview' : 'Stored visual preview'} of ${input.path}, saved version ${root.version}.${input.region ? ' Crops use the stored image resolution.' : ''} Open in elaborat.ing: ${url}` },
        { type: 'image', data: image.png, mimeType: 'image/png' },
      ],
      structuredContent: {
        status: 'ready', project_id: input.project_id, path: input.path, file_id: root.id, version: root.version,
        snapshot: meta.snapshot, inputs: meta.inputs, renderer_build: meta.renderer_build, profile: meta.profile,
        rendered_from: outcome.rendered_from, regenerated: outcome.regenerated, view_box: outcome.view_box,
        region: input.region ?? FULL_PREVIEW_REGION, pixel_width: image.width, pixel_height: image.height,
        scale: outcome.scale, diagnostics: outcome.diagnostics, stored: true, url,
      },
    }
    if (JSON.stringify(result).length > MAX_PREVIEW_RESULT_CHARS) throw new PreviewFailure('limit', 'The complete visual preview exceeds its transport limit.')
    return result
  } catch (error) {
    if (error instanceof PreviewFailure || error instanceof DrawingPreviewFailure)
      return failed(error.code, error.message, url)
    if (controller.signal.aborted) return failed('cancelled', 'The preview read timed out or was cancelled.', url)
    return failed('render_failed', 'The stored preview could not be verified. Try again.', url)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}

export function registerFilePreview(server: McpServer, context: ToolContext): void {
  server.registerTool('get_file_preview', {
    title: 'Inspect drawing',
    description: 'Read the stored PNG preview of a saved Excalidraw drawing or D2 diagram, with exact input versions and snapshot identifier. Saves prepare previews in the background; a pending response indicates when to retry. Reading never starts rendering. An optional crop requires its overview snapshot and uses the stored image resolution.',
    inputSchema: mcpInputSchema,
    annotations: { title: 'Inspect drawing', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (input, ctx) => filePreviewPayload(context, input, ctx.mcpReq.signal))
}

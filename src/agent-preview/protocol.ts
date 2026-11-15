import { z } from 'zod/mini'

export const PREVIEW_PROFILE = 'light-v1' as const
export const MAX_PREVIEW_EDGE = 1600
export const MAX_PREVIEW_PIXELS = 1_600_000
export const MAX_PREVIEW_PNG_BYTES = 96 * 1024
export const MAX_PREVIEW_BASE64_CHARS = 128 * 1024
export const MAX_PREVIEW_RESULT_CHARS = 140_000
export const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024
export const MAX_PREVIEW_D2_BYTES = 64 * 1024
export const MAX_PREVIEW_JOB_BYTES = 7 * 1024 * 1024
export const PREVIEW_TIMEOUT_MS = 45_000

const text = (limit: number) => z.string().check(z.maxLength(limit))
const digest = z.string().check(z.regex(/^[a-f0-9]{64}$/))
const build = z.string().check(z.regex(/^[a-zA-Z0-9_-]{8,64}$/))
const dimension = z.number().check(z.int(), z.minimum(1), z.maximum(MAX_PREVIEW_EDGE))

export const previewRegionSchema = z.strictObject({
  x: z.number().check(z.minimum(0), z.maximum(1)),
  y: z.number().check(z.minimum(0), z.maximum(1)),
  width: z.number().check(z.gt(0), z.maximum(1)),
  height: z.number().check(z.gt(0), z.maximum(1)),
}).check(z.refine(region => region.x + region.width <= 1 && region.y + region.height <= 1, 'The region must fit inside the complete picture.'))

export type PreviewRegion = z.infer<typeof previewRegionSchema>
export const FULL_PREVIEW_REGION: PreviewRegion = { x: 0, y: 0, width: 1, height: 1 }

export const previewJobSchema = z.strictObject({
  job_id: z.uuid(),
  input_digest: digest,
  renderer_build: build,
  profile: z.literal(PREVIEW_PROFILE),
  kind: z.enum(['drawing', 'diagram']),
  path: text(1024).check(z.minLength(1)),
  source: text(MAX_PREVIEW_FILE_BYTES),
  canvas: z.nullable(text(MAX_PREVIEW_FILE_BYTES)),
  layout: z.nullable(text(MAX_PREVIEW_FILE_BYTES)),
  region: z.nullable(previewRegionSchema),
})
export type PreviewRenderJob = z.infer<typeof previewJobSchema>

export const previewDiagnosticSchema = z.strictObject({ code: text(80), message: text(300) })
const diagnostics = z.array(previewDiagnosticSchema).check(z.maxLength(10))
const identity = {
  job_id: z.uuid(),
  input_digest: digest,
  renderer_build: build,
}
export const previewReadySchema = z.strictObject({
  ...identity,
  status: z.literal('ready'),
  profile: z.literal(PREVIEW_PROFILE),
  rendered_from: z.enum(['saved_scene', 'projected_diagram']),
  regenerated: z.boolean(),
  view_box: z.tuple([z.number(), z.number(), z.number().check(z.gt(0)), z.number().check(z.gt(0))]),
  region: previewRegionSchema,
  pixel_width: dimension,
  pixel_height: dimension,
  scale: z.number().check(z.gt(0)),
  diagnostics,
}).check(z.refine(value => value.pixel_width * value.pixel_height <= MAX_PREVIEW_PIXELS, 'The preview exceeds the pixel budget.'))
export const previewErrorSchema = z.strictObject({
  ...identity,
  status: z.literal('error'),
  code: z.enum(['invalid_input', 'unsupported', 'empty', 'limit', 'render_failed', 'd2_error']),
  message: text(300),
  diagnostics,
})
export type PreviewRenderOutcome = z.infer<typeof previewReadySchema> | z.infer<typeof previewErrorSchema>
export const previewReplySchema = z.union([
  z.strictObject({ outcome: previewReadySchema, png: z.string().check(z.minLength(4), z.maxLength(MAX_PREVIEW_BASE64_CHARS), z.regex(/^[A-Za-z0-9+/]+={0,2}$/)) }),
  z.strictObject({ outcome: previewErrorSchema }),
])
export type PreviewRenderReply = z.infer<typeof previewReplySchema>
export type PreviewRenderer = (job: PreviewRenderJob, signal?: AbortSignal) => Promise<PreviewRenderReply>

/** Validate untrusted jobs before any parsing, image decoding or browser work. */
export function parsePreviewJob(value: unknown): PreviewRenderJob {
  const job = previewJobSchema.parse(value)
  const encoder = new TextEncoder()
  if (job.kind === 'diagram' && encoder.encode(job.source).length > MAX_PREVIEW_D2_BYTES) throw new Error('Diagram previews support at most 64 KiB of D2 source.')
  for (const source of [job.source, job.canvas, job.layout]) {
    if (source !== null && encoder.encode(source).length > MAX_PREVIEW_FILE_BYTES) throw new Error('A preview source exceeds the byte budget.')
  }
  if (encoder.encode(JSON.stringify(job)).length > MAX_PREVIEW_JOB_BYTES) throw new Error('The preview job exceeds the byte budget.')
  return job
}

export function parsePreviewReply(value: unknown, job: PreviewRenderJob): PreviewRenderReply {
  const reply = previewReplySchema.parse(value)
  const outcome = reply.outcome
  if (outcome.job_id !== job.job_id || outcome.input_digest !== job.input_digest || outcome.renderer_build !== job.renderer_build) throw new Error('The renderer returned a different job.')
  if (outcome.status === 'ready') {
    const expected = job.region ?? FULL_PREVIEW_REGION
    if (JSON.stringify(outcome.region) !== JSON.stringify(expected)) throw new Error('The renderer returned a different region.')
    if (outcome.rendered_from !== (job.kind === 'drawing' ? 'saved_scene' : 'projected_diagram')) throw new Error('The renderer returned a different file kind.')
  }
  return reply
}

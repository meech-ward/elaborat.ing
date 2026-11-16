import { z } from 'zod/mini'
import {
  createPreviewRenderJob,
  createPreviewSnapshot,
  DrawingPreviewFailure,
  drawingPreviewPathSchema,
  drawingPreviewPaths,
  verifyPreviewPng,
  type DrawingPreviewInput,
} from '../_shared/drawingPreview.ts'
import { PREVIEW_PROFILE, PREVIEW_TIMEOUT_MS, parsePreviewReply, type PreviewRenderOutcome, type PreviewRenderer } from '../../../src/agent-preview/protocol.ts'

const claimedInput = z.strictObject({
  path: drawingPreviewPathSchema, id: z.nullable(z.uuid()), kind: z.nullable(z.enum(['text', 'image'])),
  version: z.nullable(z.int().check(z.minimum(1))), content: z.nullable(z.string()),
}).check(z.refine(row => row.id === null
  ? row.kind === null && row.version === null && row.content === null
  : row.kind !== null && row.version !== null && row.content !== null, 'A missing input must be consistently absent.'))
export const claimedPreviewSchema = z.strictObject({
  file_id: z.uuid(), project_id: z.uuid(), path: drawingPreviewPathSchema,
  file_version: z.int().check(z.minimum(1)), generation: z.int().check(z.minimum(1)),
  lease_token: z.uuid(), lease_expires_at: z.string().check(z.maxLength(80), z.refine(value => Number.isFinite(Date.parse(value)))),
  attempt: z.int().check(z.minimum(1), z.maximum(5)), inputs: z.array(claimedInput).check(z.minLength(1), z.maxLength(3)),
})
export type ClaimedDrawingPreview = z.infer<typeof claimedPreviewSchema>
export interface StoredDrawingPreviewMetadata {
  snapshot: string
  inputs: DrawingPreviewInput[]
  renderer_build: string
  profile: typeof PREVIEW_PROFILE
  outcome: Extract<PreviewRenderOutcome, { status: 'ready' }>
}
export interface DrawingPreviewStore {
  claim(): Promise<unknown>
  current(job: ClaimedDrawingPreview): Promise<boolean>
  publish(job: ClaimedDrawingPreview, png: string, metadata: StoredDrawingPreviewMetadata): Promise<boolean>
  fail(job: ClaimedDrawingPreview, code: string, message: string, retryable: boolean): Promise<boolean>
  release(job: ClaimedDrawingPreview): Promise<boolean>
}
export type DrawingPreviewRun = { status: 'idle' | 'completed' | 'superseded' } |
  { status: 'failed'; code: string; retryable: boolean }
interface RunOptions { rendererBuild: string; signal?: AbortSignal; pollMs?: number; timeoutMs?: number }
class SupersededPreview extends Error {}

function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

/** Claim one coalesced saved generation. Read paths never call this worker. */
export async function processNextDrawingPreview(store: DrawingPreviewStore, renderer: PreviewRenderer,
  options: RunOptions): Promise<DrawingPreviewRun> {
  if (options.signal?.aborted) return { status: 'failed', code: 'cancelled', retryable: true }
  let claimed: unknown
  try { claimed = await store.claim() }
  catch { return { status: 'failed', code: 'unavailable', retryable: true } }
  if (claimed === null) return { status: 'idle' }
  const parsed = claimedPreviewSchema.safeParse(claimed)
  if (!parsed.success) return { status: 'failed', code: 'invalid_claim', retryable: true }
  const job = parsed.data
  const controller = new AbortController()
  let done = false
  const abort = () => controller.abort(new DrawingPreviewFailure('cancelled', 'The background preview was cancelled.'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new DrawingPreviewFailure('cancelled', 'The background preview timed out.')),
    options.timeoutMs ?? PREVIEW_TIMEOUT_MS)
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason }
  const current = async () => {
    check()
    if (!await store.current(job)) throw new SupersededPreview('The drawing changed while its preview was preparing.')
    check()
  }
  let polling: Promise<void> | undefined
  try {
    const expected = drawingPreviewPaths(job.path).paths
    if (job.inputs.length !== expected.length || new Set(job.inputs.map(input => input.path)).size !== expected.length ||
      job.inputs.some(input => !expected.includes(input.path)))
      throw new DrawingPreviewFailure('invalid_input', 'The claimed preview inputs are inconsistent.')
    const rows = job.inputs.filter(input => input.id !== null)
    const snapshot = await interrupted(createPreviewSnapshot(rows, options.rendererBuild, PREVIEW_PROFILE, job.path), controller.signal)
    if (snapshot.root.id !== job.file_id || snapshot.root.version !== job.file_version)
      throw new DrawingPreviewFailure('invalid_input', 'The claimed preview identity is inconsistent.')
    await interrupted(current(), controller.signal)
    polling = (async () => {
      while (!done && !controller.signal.aborted) {
        await delay(options.pollMs ?? 1000, controller.signal)
        if (done || controller.signal.aborted) break
        try { await interrupted(current(), controller.signal) }
        catch (error) {
          if (!done && !controller.signal.aborted) controller.abort(error instanceof SupersededPreview ? error :
            new DrawingPreviewFailure('unavailable', 'The preview lease could not be verified.'))
          break
        }
      }
    })()
    const renderJob = createPreviewRenderJob(snapshot, options.rendererBuild)
    const reply = parsePreviewReply(await interrupted(renderer(renderJob, controller.signal), controller.signal), renderJob)
    check()
    const outcome = reply.outcome
    if (outcome.status === 'error') throw new DrawingPreviewFailure(outcome.code, outcome.message)
    if (!('png' in reply)) throw new DrawingPreviewFailure('render_failed', 'The renderer returned no preview image.')
    await interrupted(verifyPreviewPng(reply.png, outcome.pixel_width, outcome.pixel_height), controller.signal)
    await interrupted(current(), controller.signal)
    const metadata: StoredDrawingPreviewMetadata = { snapshot: snapshot.snapshot, inputs: snapshot.manifest,
      renderer_build: options.rendererBuild, profile: PREVIEW_PROFILE, outcome }
    if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 16_384)
      throw new DrawingPreviewFailure('limit', 'The preview metadata exceeds its stored limit.')
    check()
    const published = await interrupted(store.publish(job, reply.png, metadata), controller.signal)
    if (!published) throw new SupersededPreview('A newer saved drawing superseded this preview.')
    return { status: 'completed' }
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : error
    if (failure instanceof SupersededPreview) {
      await store.fail(job, 'cancelled', 'A newer saved drawing superseded this preview.', true).catch(() => {})
      return { status: 'superseded' }
    }
    const known = failure instanceof DrawingPreviewFailure ? failure :
      new DrawingPreviewFailure('render_failed', 'The background preview could not be prepared.')
    const retryable = ['unavailable', 'rate_limit', 'render_failed', 'cancelled'].includes(known.code)
    await store.fail(job, known.code, known.message.slice(0, 300), retryable).catch(() => {})
    return { status: 'failed', code: known.code, retryable }
  } finally {
    done = true
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    // A superseding update keeps this lease reserved until acknowledgement.
    // Releasing by token cannot clear a later worker's lease.
    await store.release(job).catch(() => {})
    await polling?.catch(() => {})
  }
}

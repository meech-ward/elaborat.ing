import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { DrawingPreviewFailure } from '../_shared/drawingPreview.ts'
import { FULL_PREVIEW_REGION, type PreviewRenderer, type PreviewRenderJob, type PreviewRenderReply } from '../../../src/agent-preview/protocol.ts'
import { processNextDrawingPreview, type ClaimedDrawingPreview, type DrawingPreviewStore, type StoredDrawingPreviewMetadata } from './jobs.ts'

const ROOT = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROJECT = 'bbbbbbbb-0000-4000-8000-000000000001'
const LEASE = 'cccccccc-0000-4000-8000-000000000001'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg=='
const build = 'renderer0001'
const root = { id: ROOT, path: 'art/a.excalidraw', version: 4, kind: 'text' as const, content: '{"elements":[]}' }
const claim = (): ClaimedDrawingPreview => ({ file_id: ROOT, project_id: PROJECT, path: root.path,
  file_version: 4, generation: 2, lease_token: LEASE, lease_expires_at: '2099-11-15T12:01:00Z', attempt: 1, inputs: [{ ...root }] })
const ready = (job: PreviewRenderJob): PreviewRenderReply => ({ png: PNG, outcome: {
  job_id: job.job_id, input_digest: job.input_digest, renderer_build: job.renderer_build,
  status: 'ready', profile: job.profile, rendered_from: job.kind === 'drawing' ? 'saved_scene' : 'projected_diagram',
  regenerated: job.kind === 'diagram', view_box: [-10, -20, 100, 50], region: FULL_PREVIEW_REGION,
  pixel_width: 1, pixel_height: 1, scale: 0.01, diagnostics: [],
} })
function fake() {
  const state = { claimed: claim() as unknown, current: true, publish: true, claims: 0, checks: 0, releases: 0,
    published: [] as Array<{ job: ClaimedDrawingPreview; png: string; metadata: StoredDrawingPreviewMetadata }>,
    failures: [] as Array<{ job: ClaimedDrawingPreview; code: string; message: string; retryable: boolean }> }
  const store: DrawingPreviewStore = {
    claim: async () => { state.claims++; return state.claimed },
    current: async () => { state.checks++; return state.current },
    publish: async (job, png, metadata) => { state.published.push({ job, png, metadata }); return state.publish },
    fail: async (job, code, message, retryable) => { state.failures.push({ job, code, message, retryable }); return true },
    release: async () => { state.releases++; return true },
  }
  return { state, store }
}

Deno.test('one queued saved generation produces verified stored pixels and the complete exact input manifest', async () => {
  const f = fake(), jobs: PreviewRenderJob[] = []
  const outcome = await processNextDrawingPreview(f.store, async job => { jobs.push(job); return ready(job) }, { rendererBuild: build })
  assertEquals(outcome, { status: 'completed' })
  assertEquals(f.state.claims, 1)
  assertEquals(jobs.length, 1)
  assertEquals(jobs[0].region, null)
  assertEquals(jobs[0].source, root.content)
  assertEquals(Object.keys(jobs[0]).includes('project_id'), false)
  assertEquals(f.state.published.length, 1)
  assertEquals(f.state.published[0].png, PNG)
  assertEquals(f.state.published[0].metadata.snapshot, jobs[0].input_digest)
  assertEquals(f.state.published[0].metadata.inputs[0].id, ROOT)
  assertEquals(f.state.published[0].metadata.inputs[0].version, 4)
  assertEquals(f.state.published[0].metadata.outcome.status, 'ready')
  assert(f.state.checks >= 2)
  assertEquals(f.state.failures, [])
  assertEquals(f.state.releases, 1)
})

Deno.test('an empty queue does not render or write and processes no second claim', async () => {
  const f = fake()
  f.state.claimed = null
  assertEquals(await processNextDrawingPreview(f.store, async () => { throw new Error('must not render') }, { rendererBuild: build }), { status: 'idle' })
  assertEquals(f.state.claims, 1)
  assertEquals(f.state.releases, 0)
  assertEquals(f.state.published, [])
})

Deno.test('coherent D2 claims preserve source, existing manual canvas and explicit missing sidecar', async () => {
  const f = fake(), jobs: PreviewRenderJob[] = []
  const value = claim()
  value.path = 'art/a.d2'
  value.inputs = [
    { path: 'art/a.d2.json', id: null, kind: null, version: null, content: null },
    { ...root, id: 'dddddddd-0000-4000-8000-000000000001', content: 'manual saved canvas', version: 9 },
    { ...root, path: value.path, content: 'a -> b' },
  ]
  f.state.claimed = value
  assertEquals(await processNextDrawingPreview(f.store, async job => { jobs.push(job); return ready(job) }, { rendererBuild: build }), { status: 'completed' })
  assertEquals(jobs[0].source, 'a -> b')
  assertEquals(jobs[0].canvas, 'manual saved canvas')
  assertEquals(jobs[0].layout, null)
  assertEquals(f.state.published[0].metadata.inputs.map(input => input.path), ['art/a.d2', root.path, 'art/a.d2.json'])
  assertEquals(f.state.published[0].metadata.inputs[2], { path: 'art/a.d2.json', id: null, version: null, sha256: null })
})

Deno.test('new generations detected before rendering acknowledge only the old lease and do not publish', async () => {
  const f = fake()
  f.state.current = false
  assertEquals(await processNextDrawingPreview(f.store, async () => { throw new Error('must not render') }, { rendererBuild: build }), { status: 'superseded' })
  assertEquals(f.state.failures[0].job.generation, 2)
  assertEquals(f.state.failures[0].code, 'cancelled')
  assertEquals(f.state.published, [])
  assertEquals(f.state.releases, 1)
})

Deno.test('periodic generation checks abort a superseded in-flight renderer even when it ignores cancellation', async () => {
  const f = fake()
  let aborted = false
  const render: PreviewRenderer = (_job, signal) => {
    signal!.addEventListener('abort', () => { aborted = true }, { once: true })
    f.state.current = false
    return new Promise(() => {})
  }
  const outcome = await processNextDrawingPreview(f.store, render, { rendererBuild: build, pollMs: 2, timeoutMs: 500 })
  assertEquals(outcome, { status: 'superseded' })
  assert(aborted)
  assertEquals(f.state.published, [])
  assertEquals(f.state.releases, 1)
})

Deno.test('a change after rendering or a failed publication CAS never turns an older generation into ready', async () => {
  for (const changed of [true, false]) {
    const f = fake()
    f.state.publish = false
    const outcome = await processNextDrawingPreview(f.store, async job => {
      if (changed) f.state.current = false
      return ready(job)
    }, { rendererBuild: build })
    assertEquals(outcome, { status: 'superseded' })
    assertEquals(f.state.published.length, changed ? 0 : 1)
    assertEquals(f.state.releases, 1)
  }
})

Deno.test('native syntax, empty and unsupported outputs stop retries until a fresh saved generation', async () => {
  for (const code of ['d2_error', 'empty', 'unsupported', 'limit', 'invalid_input'] as const) {
    const f = fake()
    const outcome = await processNextDrawingPreview(f.store, async job => ({ outcome: {
      job_id: job.job_id, input_digest: job.input_digest, renderer_build: job.renderer_build,
      status: 'error', code, message: 'The saved input cannot be rendered.', diagnostics: [],
    } }), { rendererBuild: build })
    assertEquals(outcome, { status: 'failed', code, retryable: false })
    assertEquals(f.state.failures[0].retryable, false)
    assertEquals(f.state.published, [])
    assertEquals(f.state.releases, 1)
  }
})

Deno.test('transient provider refusals become bounded safe retry records without exposing exceptions', async () => {
  for (const code of ['unavailable', 'rate_limit', 'render_failed'] as const) {
    const f = fake()
    const outcome = await processNextDrawingPreview(f.store, async () => { throw new DrawingPreviewFailure(code, 'Preview service temporarily unavailable.') }, { rendererBuild: build })
    assertEquals(outcome, { status: 'failed', code, retryable: true })
    assertEquals(f.state.failures[0].retryable, true)
    assertEquals(f.state.releases, 1)
  }
  const f = fake()
  await processNextDrawingPreview(f.store, async () => { throw new Error('private SQL or provider token must not escape') }, { rendererBuild: build })
  assertEquals(f.state.failures[0].message, 'The background preview could not be prepared.')
})

Deno.test('timeouts and shutdown signals abort browser work and release the matching generation lease', async () => {
  for (const external of [true, false]) {
    const f = fake(), stopping = new AbortController()
    let aborted = false
    const outcome = await processNextDrawingPreview(f.store, (_job, signal) => {
      signal!.addEventListener('abort', () => { aborted = true }, { once: true })
      if (external) stopping.abort()
      return new Promise(() => {})
    }, { rendererBuild: build, signal: stopping.signal, timeoutMs: 10, pollMs: 2 })
    assertEquals(outcome, { status: 'failed', code: 'cancelled', retryable: true })
    assert(aborted)
    assertEquals(f.state.published, [])
    assertEquals(f.state.releases, 1)
  }
  const f = fake(), stopping = new AbortController()
  stopping.abort()
  await processNextDrawingPreview(f.store, async () => { throw new Error('must not render') }, { rendererBuild: build, signal: stopping.signal })
  assertEquals(f.state.claims, 0)
})

Deno.test('lease-check failure during a render aborts output instead of publishing unchecked bytes', async () => {
  const f = fake()
  let checks = 0
  f.store.current = async () => { if (++checks > 1) throw new Error('private database details'); return true }
  const outcome = await processNextDrawingPreview(f.store, () => new Promise(() => {}), { rendererBuild: build, pollMs: 2, timeoutMs: 500 })
  assertEquals(outcome, { status: 'failed', code: 'unavailable', retryable: true })
  assertEquals(f.state.published, [])
  assertEquals(f.state.releases, 1)
})

Deno.test('corrupt PNG payloads and renderer identity mismatches never publish artifacts', async () => {
  for (const corrupt of [true, false]) {
    const f = fake()
    const outcome = await processNextDrawingPreview(f.store, async job => {
      const result = ready(job)
      if (corrupt && 'png' in result) {
        const bytes = Uint8Array.from(atob(result.png), character => character.charCodeAt(0))
        // Keep plausible PNG dimensions/chunks; break the actual zlib stream.
        bytes[41] ^= 255
        result.png = btoa(String.fromCharCode(...bytes))
      } else result.outcome.input_digest = 'b'.repeat(64)
      return result
    }, { rendererBuild: build })
    assertEquals(outcome, { status: 'failed', code: 'render_failed', retryable: true })
    assertEquals(f.state.published, [])
    assertEquals(f.state.releases, 1)
  }
})

Deno.test('inconsistent claim roots or missing companion records fail before renderer work', async () => {
  for (const input of [
    { ...claim(), file_version: 3 },
    { ...claim(), file_id: 'eeeeeeee-0000-4000-8000-000000000001' },
    { ...claim(), path: 'art/a.d2', inputs: [{ ...root, path: 'art/a.d2' }] },
  ]) {
    const f = fake()
    f.state.claimed = input
    assertEquals(await processNextDrawingPreview(f.store, async () => { throw new Error('must not render') }, { rendererBuild: build }),
      { status: 'failed', code: 'invalid_input', retryable: false })
    assertEquals(f.state.releases, 1)
  }
})

Deno.test('failed publication and failure-record calls still acknowledge the lease without exposing SQL', async () => {
  const f = fake()
  f.store.publish = async () => { throw new Error('private SQL values') }
  f.store.fail = async () => { throw new Error('database unavailable') }
  assertEquals(await processNextDrawingPreview(f.store, async job => ready(job), { rendererBuild: build }),
    { status: 'failed', code: 'render_failed', retryable: true })
  assertEquals(f.state.releases, 1)
})

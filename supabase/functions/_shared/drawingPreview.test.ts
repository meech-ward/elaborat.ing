import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19'
import { createPreviewRenderJob, createPreviewSnapshot, DrawingPreviewFailure, renderPreviewThroughWorker, verifyPreviewPng } from './drawingPreview.ts'
import { FULL_PREVIEW_REGION, type PreviewRenderJob, type PreviewRenderReply } from '../../../src/agent-preview/protocol.ts'

const ROOT = 'aaaaaaaa-0000-4000-8000-000000000001'
const id = 'bbbbbbbb-0000-4000-8000-000000000001'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg=='
const root = { id: ROOT, path: 'art/a.d2', kind: 'text' as const, content: 'a -> b', version: 4 }
const build = 'renderer0001'
const secret = 'a-separate-private-render-service-credential'
const ready = (job: PreviewRenderJob): PreviewRenderReply => ({ png: PNG, outcome: {
  job_id: job.job_id, input_digest: job.input_digest, renderer_build: job.renderer_build,
  status: 'ready', profile: job.profile, rendered_from: job.kind === 'drawing' ? 'saved_scene' : 'projected_diagram',
  regenerated: false, view_box: [0, 0, 10, 10], region: FULL_PREVIEW_REGION,
  pixel_width: 1, pixel_height: 1, scale: 0.1, diagnostics: [],
} })
const job = async () => createPreviewRenderJob(await createPreviewSnapshot([root], build, 'light-v1', root.path), build)

Deno.test('snapshot formula matches the prior MCP contract and explicitly includes absent companions', async () => {
  const snapshot = await createPreviewSnapshot([root], build, 'light-v1', root.path)
  assertEquals(snapshot.kind, 'diagram')
  assertEquals(snapshot.manifest.map(item => item.path), ['art/a.d2', 'art/a.excalidraw', 'art/a.d2.json'])
  assertEquals(snapshot.manifest.slice(1), [
    { path: 'art/a.excalidraw', id: null, version: null, sha256: null },
    { path: 'art/a.d2.json', id: null, version: null, sha256: null },
  ])
  const input = new TextEncoder().encode(JSON.stringify({ inputs: snapshot.manifest, renderer_build: build, profile: 'light-v1' }))
  const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), byte => byte.toString(16).padStart(2, '0')).join('')
  assertEquals(snapshot.snapshot, expected)
})

Deno.test('snapshot identity covers companions, exact source bytes, renderer build and profile independently of row order', async () => {
  const canvas = { ...root, id, path: 'art/a.excalidraw', content: 'manual canvas', version: 7 }
  const before = await createPreviewSnapshot([root, canvas], build, 'light-v1', root.path)
  assertEquals((await createPreviewSnapshot([canvas, root], build, 'light-v1', root.path)).snapshot, before.snapshot)
  for (const snapshot of [
    await createPreviewSnapshot([root, { ...canvas, version: 8 }], build, 'light-v1', root.path),
    await createPreviewSnapshot([root, { ...canvas, content: 'moved manual canvas' }], build, 'light-v1', root.path),
    await createPreviewSnapshot([{ ...root, content: root.content + '\n' }, canvas], build, 'light-v1', root.path),
    await createPreviewSnapshot([root, canvas], 'renderer0002', 'light-v1', root.path),
    await createPreviewSnapshot([root, canvas], build, 'light-v2', root.path),
  ]) assert(snapshot.snapshot !== before.snapshot)
})

Deno.test('snapshot rejects duplicate, unrelated, non-text and oversized external rows', async () => {
  for (const rows of [
    [root, root], [root, { ...root, id, path: 'private/unrelated.md' }],
    [{ ...root, kind: 'image' }], [{ ...root, content: 'x'.repeat(65_537) }],
    [{ ...root, path: 'art/a.excalidraw', content: '😀'.repeat(524_289) }],
  ]) await assertRejects(() => createPreviewSnapshot(rows, build, 'light-v1', rows[0].path), DrawingPreviewFailure)
})

Deno.test('render jobs contain only frozen native inputs and always request an overview', async () => {
  const snapshot = await createPreviewSnapshot([root], build, 'light-v1', root.path)
  const value = createPreviewRenderJob(snapshot, build)
  assertEquals(value.kind, 'diagram')
  assertEquals(value.canvas, null)
  assertEquals(value.layout, null)
  assertEquals(value.region, null)
  assertEquals(value.input_digest, snapshot.snapshot)
  assertEquals(Object.keys(value).some(key => /project|user|token|secret/.test(key)), false)
})

Deno.test('transport uses only its service credential and has no environment dependency when supplied explicitly', async () => {
  const input = await job()
  const oldGet = Deno.env.get
  Deno.env.get = () => { throw new Error('must not read environment') }
  try {
    const result = await renderPreviewThroughWorker(input, undefined, { secret, endpoint: 'https://renderer.test/_agent-preview',
      fetcher: (async (url: URL | RequestInfo, init?: RequestInit) => {
        assertEquals(String(url), 'https://renderer.test/_agent-preview')
        assertEquals(init?.redirect, 'error')
        assertEquals(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`)
        assertEquals(JSON.parse(String(init?.body)), input)
        assertEquals(String(init?.body).includes(secret), false)
        return Response.json(ready(input))
      }) as typeof fetch })
    assertEquals(result, ready(input))
  } finally { Deno.env.get = oldGet }
})

Deno.test('transport refuses credential URLs and insecure origins without fetching', async () => {
  for (const endpoint of ['http://renderer.test/x', 'https://user:password@renderer.test/x', 'https://renderer.test/x?token=1', 'https://renderer.test/x#x'])
    await assertRejects(() => renderPreviewThroughWorker({} as PreviewRenderJob, undefined, { secret, endpoint,
      fetcher: (async () => { throw new Error('must not fetch') }) as typeof fetch }), DrawingPreviewFailure)
})

Deno.test('rate limits, redirects and arbitrary provider failures produce safe bounded diagnostics', async () => {
  const input = await job()
  try {
    await renderPreviewThroughWorker(input, undefined, { secret, endpoint: 'https://renderer.test',
      fetcher: (async () => new Response('private provider details', { status: 429, headers: { 'Retry-After': '999999' } })) as typeof fetch })
    throw new Error('expected refusal')
  } catch (error) {
    assert(error instanceof DrawingPreviewFailure)
    assertEquals(error.code, 'rate_limit')
    assertEquals(error.retryAfter, 86_400)
    assert(!error.message.includes('private'))
  }
  for (const status of [307, 401, 500]) {
    const error = await assertRejects(() => renderPreviewThroughWorker(input, undefined, { secret, endpoint: 'https://renderer.test',
      fetcher: (async () => new Response('private provider details', { status })) as typeof fetch }), DrawingPreviewFailure)
    assertEquals(error.code, 'unavailable')
    assert(!error.message.includes('private'))
  }
})

Deno.test('transport bounds declared and actual bytes and rejects another job reply', async () => {
  const input = await job()
  for (const response of [
    new Response('x', { headers: { 'Content-Length': '999999999' } }), new Response('x'.repeat(200_000)),
    Response.json({ ...ready(input), outcome: { ...ready(input).outcome, input_digest: 'b'.repeat(64) } }), new Response('not JSON'),
  ]) await assertRejects(() => renderPreviewThroughWorker(input, undefined, { secret, endpoint: 'https://renderer.test',
    fetcher: (async () => response) as typeof fetch }), DrawingPreviewFailure)
})

Deno.test('PNG verification performs an actual bounded decode and refuses corrupted compressed pixels', async () => {
  const bytes = await verifyPreviewPng(PNG, 1, 1)
  assertEquals(bytes.byteLength, atob(PNG).length)
  await assertRejects(() => verifyPreviewPng(PNG, 2, 1), DrawingPreviewFailure)
  const corrupted = bytes.slice()
  corrupted[41] ^= 255
  await assertRejects(() => verifyPreviewPng(btoa(String.fromCharCode(...corrupted)), 1, 1), DrawingPreviewFailure)
})

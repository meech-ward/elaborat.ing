import { describe, expect, test } from 'bun:test'
import {
  createAgentPreviewHandler,
  previewAssetAllowed,
  type PreviewBrowser,
  type PreviewBrowserLauncher,
  type PreviewPage,
  type PreviewRequest,
} from './agentPreview.ts'
import { MAX_PREVIEW_JOB_BYTES, type PreviewRenderJob, type PreviewRenderReply } from '../src/agent-preview/protocol.ts'
import { handle } from './index.ts'

const secret = 'a-private-render-secret-with-at-least-32-characters'
const origin = 'https://site.test'
const entry = '/agent-preview/build0001/index.html'
const asset = '/agent-preview/build0001/assets/render.js'
const job: PreviewRenderJob = {
  job_id: '00000000-0000-4000-8000-000000000001', input_digest: 'a'.repeat(64), renderer_build: 'build0001',
  profile: 'light-v1', kind: 'drawing', path: 'drawing.excalidraw', source: '{}', canvas: null, layout: null, region: null,
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII='
const reply = (input: PreviewRenderJob = job): PreviewRenderReply => ({
  outcome: {
    job_id: input.job_id, input_digest: input.input_digest, renderer_build: input.renderer_build,
    status: 'ready', profile: 'light-v1', rendered_from: 'saved_scene', regenerated: false,
    view_box: [0, 0, 1, 1], region: input.region ?? { x: 0, y: 0, width: 1, height: 1 },
    pixel_width: 1, pixel_height: 1, scale: 1, diagnostics: [],
  }, png,
})
const env = { AGENT_PREVIEW_SECRET: secret, BROWSER: { privateBinding: true }, PREVIEW_RATE_LIMITER: { limit: async () => ({ success: true }) } }
const request = (body: unknown = job, options: RequestInit = {}) => new Request(`${origin}/_agent-preview`, {
  method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body), ...options,
})
const options = { build: job.renderer_build, entry, assets: [asset], timeoutMs: 1000, cleanupMs: 5 }

function fixture(execute: (job: PreviewRenderJob) => Promise<unknown> = async input => JSON.stringify(reply(input))) {
  const seen = { launched: 0, contexts: 0, contextClosed: 0, closed: 0, intercepted: false, bypass: false,
    cache: true, navigation: '', hostname: '', input: null as PreviewRenderJob | null }
  let intercept: ((request: PreviewRequest) => void) | undefined
  const page: PreviewPage = {
    async setRequestInterception(value) { seen.intercepted = value },
    async setBypassServiceWorker(value) { seen.bypass = value },
    async setCacheEnabled(value) { seen.cache = value },
    on(_event, callback) { intercept = callback },
    async goto(url) { seen.navigation = url },
    async waitForFunction() {},
    async evaluate(_callback, input) { seen.input = input; return execute(input) },
  }
  const browser: PreviewBrowser = {
    async createBrowserContext() {
      seen.contexts++
      return { async newPage() { return page }, async close() { seen.contextClosed++ } }
    },
    async close() { seen.closed++ },
  }
  const launch: PreviewBrowserLauncher = async (_binding, hostname) => { seen.launched++; seen.hostname = hostname; return browser }
  return { seen, browser, launch, intercept: () => intercept }
}

describe('private agent preview provider', () => {
  test('rejects unavailable, unauthenticated and unsupported-method calls before browser work', async () => {
    const port = fixture()
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    expect((await render(request(), {})).status).toBe(503)
    expect((await render(request(), { ...env, AGENT_PREVIEW_SECRET: 'short' })).status).toBe(503)
    expect((await render(request(job, { headers: { 'Content-Type': 'application/json' } }), env)).status).toBe(401)
    expect((await render(request(job, { headers: { Authorization: `Bearer ${secret}x`, 'Content-Type': 'application/json' } }), env)).status).toBe(401)
    expect((await render(new Request(`${origin}/_agent-preview`), env)).status).toBe(405)
    expect(port.seen.launched).toBe(0)
  })

  test('service limiting fails closed, is shared by a fixed key and runs only after authentication', async () => {
    const port = fixture()
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    expect((await render(request(), { ...env, PREVIEW_RATE_LIMITER: undefined })).status).toBe(503)
    expect((await render(request(), { ...env, PREVIEW_RATE_LIMITER: { limit: async () => { throw new Error('provider failure') } } })).status).toBe(503)
    const keys: string[] = []
    const limited = { ...env, PREVIEW_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false } } } }
    const denied = await render(request(), limited)
    expect(denied.status).toBe(429)
    expect(denied.headers.get('Retry-After')).toBe('60')
    expect((await render(request(job, { headers: { Authorization: 'Bearer wrong' } }), limited)).status).toBe(401)
    expect(keys).toEqual(['agent-preview'])
    expect(port.seen.launched).toBe(0)
  })

  test('uses an isolated context and a fixed entry, returns validated pixels, and always closes', async () => {
    const port = fixture()
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    const pending: Promise<unknown>[] = []
    const result = await render(request(), env, { waitUntil(value) { pending.push(value) } })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual(reply())
    expect(result.headers.get('Cache-Control')).toBe('no-store')
    expect(result.headers.has('Access-Control-Allow-Origin')).toBe(false)
    await Promise.all(pending)
    expect(port.seen).toMatchObject({ launched: 1, contexts: 1, contextClosed: 1, closed: 1,
      intercepted: true, bypass: true, cache: false, navigation: `${origin}/agent-preview/build0001/`, hostname: 'site.test', input: job })
    expect(JSON.stringify(port.seen.input)).not.toContain(secret)
    let continued = 0, aborted = 0
    const intercept = port.intercept()!
    for (const url of [`${origin}${asset}`, `${origin}${entry}`, `${origin}/agent-preview/build0001/`,
      `${origin}/agent-preview/build0001/assets/`, `${origin}/agent-preview/other/`, 'https://evil.test/pixels', `${origin}${asset}?private=1`])
      intercept({ url: () => url, method: () => 'GET', continue: async () => { continued++ }, abort: async () => { aborted++ } })
    expect(continued).toBe(3)
    expect(aborted).toBe(4)
  })

  test('rejects invalid jobs, caller-controlled provider options and unknown builds before launching', async () => {
    const port = fixture()
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    expect((await render(request({ ...job, url: 'https://evil.test' }), env)).status).toBe(400)
    expect((await render(request({ ...job, region: { x: 0.9, y: 0, width: 0.2, height: 1 } }), env)).status).toBe(400)
    expect((await render(request({ ...job, renderer_build: 'unknown00' }), env)).status).toBe(409)
    expect((await render(request(job, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'text/plain' } }), env)).status).toBe(415)
    expect(port.seen.launched).toBe(0)
  })

  test('reads retained manifests only through ASSETS and keeps each old job on its exact renderer assets', async () => {
    const old = { ...job, renderer_build: '0123456789abcdef' }
    const oldEntry = `/agent-preview/${old.renderer_build}/index.html`
    const oldAsset = `/agent-preview/${old.renderer_build}/assets/render-old.js`
    const port = fixture()
    const reads: string[] = []
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    const result = await render(request(old), { ...env, ASSETS: { async fetch(input) {
      reads.push(input.url)
      return Response.json({ build: old.renderer_build, entry: oldEntry, assets: [oldAsset] })
    } } })
    expect(result.status).toBe(200)
    expect(reads).toEqual([`${origin}/agent-preview/${old.renderer_build}/manifest.json`])
    expect(port.seen.navigation).toBe(`${origin}/agent-preview/${old.renderer_build}/`)
    let allowed = 0, blocked = 0
    for (const path of [oldAsset, oldEntry, `/agent-preview/${old.renderer_build}/`, asset, '/agent-preview/build0001/']) port.intercept()!({ url: () => `${origin}${path}`, method: () => 'GET',
      continue: async () => { allowed++ }, abort: async () => { blocked++ } })
    expect(allowed).toBe(3)
    expect(blocked).toBe(2)
  })

  test('rejects missing, oversized and adversarial retained manifests before browser acquisition', async () => {
    const old = { ...job, renderer_build: '0123456789abcdef' }
    const oldEntry = `/agent-preview/${old.renderer_build}/index.html`
    const valid = { build: old.renderer_build, entry: oldEntry, assets: [oldEntry] }
    const invalid = [
      { ...valid, build: 'ffffffffffffffff' }, { ...valid, entry: 'https://evil.test/index.html' },
      { ...valid, assets: [oldEntry + '?secret=1'] }, { ...valid, assets: [oldEntry + '#x'] },
      { ...valid, assets: [`/agent-preview/${old.renderer_build}/../other.js`] },
      { ...valid, assets: [`/agent-preview/${old.renderer_build}/%2e%2e/other.js`] },
      { ...valid, assets: [asset] }, { ...valid, assets: Array(601).fill(oldEntry) }, { ...valid, script: 'evil()' },
    ]
    const port = fixture()
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    for (const manifest of invalid)
      expect((await render(request(old), { ...env, ASSETS: { fetch: async () => Response.json(manifest) } })).status).toBe(409)
    expect((await render(request(old), { ...env, ASSETS: { fetch: async () => new Response('x'.repeat(80_001)) } })).status).toBe(409)
    expect((await render(request(old), { ...env, ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } })).status).toBe(409)
    expect(port.seen.launched).toBe(0)
  })

  test('caps actual streamed input even when Content-Length is omitted or lies', async () => {
    const port = fixture()
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    const oversized = new Uint8Array(MAX_PREVIEW_JOB_BYTES + 1)
    const result = await render(request(job, { body: oversized, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Content-Length': '1' } }), env)
    expect(result.status).toBe(413)
    expect((await render(request(job, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Content-Length': String(MAX_PREVIEW_JOB_BYTES + 1) } }), env)).status).toBe(413)
    expect(port.seen.launched).toBe(0)
  })

  test('refuses malformed, oversized, mismatched and corrupt renderer replies without exposing raw errors', async () => {
    for (const value of [
      null, 'x'.repeat(140_001), '{}', JSON.stringify({ ...reply(), png: btoa('not a PNG') }),
      JSON.stringify({ ...reply(), outcome: { ...reply().outcome, job_id: '00000000-0000-4000-8000-000000000002' } }),
      JSON.stringify({ ...reply(), outcome: { ...reply().outcome, pixel_width: 2 } }),
    ]) {
      const port = fixture(async () => value)
      const result = await createAgentPreviewHandler({ ...options, launch: port.launch })(request(), env)
      expect(result.status).toBe(502)
      expect(await result.text()).not.toContain(job.source)
      expect(port.seen.closed).toBe(1)
    }
  })

  test('returns bounded renderer diagnostics as an error outcome without inventing pixels', async () => {
    const failure: PreviewRenderReply = { outcome: { job_id: job.job_id, input_digest: job.input_digest,
      renderer_build: job.renderer_build, status: 'error', code: 'empty', message: 'The drawing is empty.', diagnostics: [] } }
    const port = fixture(async () => JSON.stringify(failure))
    const result = await createAgentPreviewHandler({ ...options, launch: port.launch })(request(), env)
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual(failure)
  })

  test('limits local concurrency and releases the slot after completion', async () => {
    let finish!: (value: unknown) => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const port = fixture(async () => { entered(); return new Promise(resolve => { finish = resolve }) })
    const render = createAgentPreviewHandler({ ...options, launch: port.launch })
    const first = render(request(), env)
    await ready
    const second = await render(request(), env)
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBe('5')
    finish(JSON.stringify(reply()))
    expect((await first).status).toBe(200)
    expect(port.seen.launched).toBe(1)
  })

  test('deadline closes a running browser and caller cancellation closes its context', async () => {
    for (const cancel of [false, true]) {
      let entered!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      const port = fixture(async () => { entered(); return new Promise(() => {}) })
      const controller = new AbortController()
      const render = createAgentPreviewHandler({ ...options, launch: port.launch, timeoutMs: 20 })
      const running = render(request(job, { signal: controller.signal }), env)
      await ready
      if (cancel) controller.abort()
      const result = await running
      expect(result.status).toBe(cancel ? 499 : 504)
      expect(port.seen.closed).toBe(1)
      expect(port.seen.contextClosed).toBe(1)
    }
  })

  test('a browser acquired after timeout is closed and receives no job data', async () => {
    const port = fixture()
    let acquire!: (value: PreviewBrowser) => void
    const pending: Promise<unknown>[] = []
    const render = createAgentPreviewHandler({ ...options, timeoutMs: 10, launch: async () => new Promise(resolve => { acquire = resolve }) })
    const result = await render(request(), env, { waitUntil(value) { pending.push(value) } })
    expect(result.status).toBe(504)
    acquire(port.browser)
    await Promise.all(pending)
    expect(port.seen.closed).toBe(1)
    expect(port.seen.contexts).toBe(0)
    expect(port.seen.input).toBeNull()
  })

  test('provider rate errors are retryable and do not reveal its response body', async () => {
    const render = createAgentPreviewHandler({ ...options, launch: async () => { throw new Error('Unable to create new browser: code: 429: message: private account details') } })
    const result = await render(request(), env)
    expect(result.status).toBe(429)
    expect(result.headers.get('Retry-After')).toBe('20')
    expect(await result.text()).not.toContain('private account')
  })

  test('the Worker reserves the internal endpoint instead of serving the SPA fallback', async () => {
    const result = await handle(request(), { ASSETS: { fetch: async () => { throw new Error('must not serve assets') } } })
    expect(result.status).toBe(503)
  })
})

test('asset policy permits only exact same-origin GET paths without query strings or credentials', () => {
  const paths = new Set([entry, asset])
  expect(previewAssetAllowed(`${origin}${asset}`, 'GET', origin, paths)).toBe(true)
  for (const [url, method] of [
    [`${origin}${asset}?x=1`, 'GET'], [`${origin}${asset}#x`, 'GET'],
    ['https://user:password@site.test' + asset, 'GET'], ['https://site.test.evil.test' + asset, 'GET'],
    [`${origin}/unknown`, 'GET'], [`${origin}${asset}`, 'POST'], ['data:text/html,hi', 'GET'], ['not a url', 'GET'],
  ]) expect(previewAssetAllowed(url, method, origin, paths)).toBe(false)
})

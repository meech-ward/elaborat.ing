import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod/mini'
import {
  MAX_PREVIEW_JOB_BYTES,
  MAX_PREVIEW_PNG_BYTES,
  MAX_PREVIEW_RESULT_CHARS,
  PREVIEW_TIMEOUT_MS,
  parsePreviewJob,
  parsePreviewReply,
  type PreviewRenderJob,
  type PreviewRenderReply,
} from '../src/agent-preview/protocol.ts'
import { inspectImage } from '../src/features/images/format.ts'
import { PREVIEW_ASSETS, PREVIEW_BUILD, PREVIEW_ENTRY } from '../supabase/functions/mcp-server/tools/previewManifest.ts'

export const AGENT_PREVIEW_PATH = '/_agent-preview'

export interface AgentPreviewEnv {
  AGENT_PREVIEW_SECRET?: string
  BROWSER?: unknown
  ASSETS?: { fetch(request: Request): Promise<Response> }
  PREVIEW_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}
export interface PreviewExecutionContext { waitUntil(promise: Promise<unknown>): void }

/** The small browser surface used here also makes failure/cleanup tests independent of Cloudflare. */
export interface PreviewRequest {
  url(): string
  method(): string
  continue(): Promise<void>
  abort(): Promise<void>
}
export interface PreviewPage {
  setRequestInterception(enabled: boolean): Promise<void>
  setBypassServiceWorker(enabled: boolean): Promise<void>
  setCacheEnabled(enabled: boolean): Promise<void>
  on(event: 'request', handler: (request: PreviewRequest) => void): unknown
  goto(url: string, options: { waitUntil: 'networkidle0'; timeout: number }): Promise<unknown>
  waitForFunction(callback: () => boolean, options: { timeout: number }): Promise<unknown>
  evaluate(callback: (job: PreviewRenderJob) => Promise<string>, job: PreviewRenderJob): Promise<unknown>
}
export interface PreviewBrowserContext {
  newPage(): Promise<PreviewPage>
  close(): Promise<void>
}
export interface PreviewBrowser {
  createBrowserContext(): Promise<PreviewBrowserContext>
  close(): Promise<void>
}
export type PreviewBrowserLauncher = (binding: unknown, hostname: string) => Promise<PreviewBrowser>

async function launchBrowser(binding: unknown, hostname: string): Promise<PreviewBrowser> {
  // Worker-only dependency. Ordinary app pages never import this module.
  const { default: puppeteer } = await import('@cloudflare/puppeteer')
  const browser = await puppeteer.launch(binding as Parameters<typeof puppeteer.launch>[0], {
    recording: false,
    guardrails: { allowedDomains: [hostname] },
  })
  return browser as unknown as PreviewBrowser
}

class PreviewHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const response = (status: number, body: unknown, retryAfter?: string): Response => Response.json(body, {
  status,
  headers: {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
  },
})

/** Hash to fixed-length digests before the runtime's timing-safe comparison. */
async function authorized(request: Request, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization') ?? '')),
    crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`)),
  ])
  return timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected))
}

async function readJob(request: Request): Promise<PreviewRenderJob> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? ''))
    throw new PreviewHttpError(415, 'invalid_input', 'Send the preview job as JSON.')
  const declared = request.headers.get('Content-Length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PREVIEW_JOB_BYTES))
    throw new PreviewHttpError(413, 'limit', 'The preview job exceeds the byte budget.')
  if (!request.body) throw new PreviewHttpError(400, 'invalid_input', 'A preview job is required.')
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_PREVIEW_JOB_BYTES) {
        await reader.cancel()
        throw new PreviewHttpError(413, 'limit', 'The preview job exceeds the byte budget.')
      }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  try { return parsePreviewJob(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
  catch { throw new PreviewHttpError(400, 'invalid_input', 'The preview job is invalid or exceeds its limits.') }
}

/** Every HTTP request must be one exact published asset, with no query/credential channel. */
export function previewAssetAllowed(url: string, method: string, origin: string, paths: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(url)
    return method === 'GET' && parsed.origin === origin && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash && paths.has(parsed.pathname)
  } catch { return false }
}

function validateReply(value: unknown, job: PreviewRenderJob): PreviewRenderReply {
  if (typeof value !== 'string' || value.length > MAX_PREVIEW_RESULT_CHARS)
    throw new Error('Invalid renderer result size.')
  const reply = parsePreviewReply(JSON.parse(value), job)
  if (reply.outcome.status === 'ready' && 'png' in reply) {
    const bytes = Uint8Array.from(atob(reply.png), character => character.charCodeAt(0))
    const image = inspectImage(bytes, 'image/png', MAX_PREVIEW_PNG_BYTES)
    if (image.mediaType !== 'image/png' || image.animated || image.width !== reply.outcome.pixel_width || image.height !== reply.outcome.pixel_height)
      throw new Error('Invalid renderer image.')
  }
  return reply
}

interface HandlerOptions {
  launch?: PreviewBrowserLauncher
  timeoutMs?: number
  cleanupMs?: number
  build?: string
  entry?: string
  assets?: readonly string[]
}

const retainedManifest = z.strictObject({
  build: z.string(), entry: z.string(), assets: z.array(z.string()).check(z.maxLength(600)),
})

// Cloudflare Assets canonicalizes directory index.html to its trailing-slash
// URL. Derive only that exact alias from the trusted manifest entry; other
// directories remain outside the request allowlist.
function canonicalEntry(entry: string): string {
  return entry.endsWith('/index.html') ? entry.slice(0, -'index.html'.length) : entry
}

async function rendererPaths(job: PreviewRenderJob, origin: string, env: AgentPreviewEnv,
  current: { build: string; entry: string; paths: ReadonlySet<string> }) {
  if (job.renderer_build === current.build) return current
  const unavailable = () => new PreviewHttpError(409, 'build_conflict', 'The requested renderer build is unavailable.')
  if (!/^[a-f0-9]{16}$/.test(job.renderer_build) || !env.ASSETS) throw unavailable()
  try {
    const prefix = `/agent-preview/${job.renderer_build}/`
    const result = await env.ASSETS.fetch(new Request(new URL(`${prefix}manifest.json`, origin)))
    if (!result.ok || !result.body) throw unavailable()
    const reader = result.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '', bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        if ((bytes += part.value.byteLength) > 80_000) { await reader.cancel(); throw unavailable() }
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
    } finally { reader.releaseLock() }
    const manifest = retainedManifest.parse(JSON.parse(text))
    if (manifest.build !== job.renderer_build) throw unavailable()
    const safePath = (path: string) => path.startsWith(prefix) && /^[a-zA-Z0-9_./~-]+$/.test(path) &&
      path.slice(prefix.length).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
    if (!safePath(manifest.entry) || !manifest.entry.endsWith('.html') || !manifest.assets.every(safePath)) throw unavailable()
    const canonical = canonicalEntry(manifest.entry)
    return { build: manifest.build, entry: canonical, paths: new Set([manifest.entry, canonical, ...manifest.assets]) }
  } catch { throw unavailable() }
}

/** One active job per isolate; the provider separately enforces its account quotas. */
export function createAgentPreviewHandler(options: HandlerOptions = {}) {
  const launch = options.launch ?? launchBrowser
  const timeoutMs = options.timeoutMs ?? PREVIEW_TIMEOUT_MS - 3_000
  const cleanupMs = options.cleanupMs ?? 1_000
  const build = options.build ?? PREVIEW_BUILD
  const entry = options.entry ?? PREVIEW_ENTRY
  const canonical = canonicalEntry(entry)
  const paths = new Set([entry, canonical, ...(options.assets ?? PREVIEW_ASSETS)])
  let active = false
  return async (request: Request, env: AgentPreviewEnv, background?: PreviewExecutionContext): Promise<Response> => {
    if (request.method !== 'POST') return response(405, { error: 'method', message: 'Use POST.' })
    if (!env.AGENT_PREVIEW_SECRET || env.AGENT_PREVIEW_SECRET.length < 32 || !env.BROWSER)
      return response(503, { error: 'unavailable', message: 'Agent previews are not configured.' })
    if (!await authorized(request, env.AGENT_PREVIEW_SECRET))
      return response(401, { error: 'unauthorized', message: 'The preview request is not authorized.' })
    if (active) return response(429, { error: 'rate_limit', message: 'A preview is already rendering. Retry shortly.' }, '5')
    if (!env.PREVIEW_RATE_LIMITER)
      return response(503, { error: 'unavailable', message: 'The preview rate limit is not configured.' })
    try {
      if (!(await env.PREVIEW_RATE_LIMITER.limit({ key: 'agent-preview' })).success)
        return response(429, { error: 'rate_limit', message: 'The preview service is at its limit. Retry later.' }, '60')
    } catch { return response(503, { error: 'unavailable', message: 'The preview rate limit is unavailable.' }) }
    // Recheck after the asynchronous location-wide limiter: simultaneous calls
    // may both have observed the isolate slot as free before it answered.
    if (active) return response(429, { error: 'rate_limit', message: 'A preview is already rendering. Retry shortly.' }, '5')
    active = true
    let browser: PreviewBrowser | undefined
    let acquisition: Promise<PreviewBrowser> | undefined
    let context: PreviewBrowserContext | undefined
    let closing: Promise<void> | undefined
    let stopped = false
    const close = () => {
      if (!browser) return Promise.resolve()
      closing ??= Promise.allSettled([context?.close(), browser.close()]).then(() => {})
      return closing
    }
    const checkActive = () => { if (stopped) throw new PreviewHttpError(504, 'timeout', 'The preview timed out.') }
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => {
          stopped = true
          void close()
          reject(new PreviewHttpError(499, 'cancelled', 'The preview request was cancelled.'))
        }
        request.signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => {
          stopped = true
          void close()
          reject(new PreviewHttpError(504, 'timeout', 'The preview timed out.'))
        }, timeoutMs)
        if (request.signal.aborted) abort()
      })
      const render = async () => {
        const job = await readJob(request)
        checkActive()
        const origin = new URL(request.url).origin
        const renderer = await rendererPaths(job, origin, env, { build, entry: canonical, paths })
        checkActive()
        acquisition = launch(env.BROWSER, new URL(origin).hostname)
        browser = await acquisition
        if (stopped) { await close(); checkActive() }
        context = await browser.createBrowserContext()
        checkActive()
        const page = await context.newPage()
        checkActive()
        await page.setBypassServiceWorker(true)
        await page.setCacheEnabled(false)
        await page.setRequestInterception(true)
        page.on('request', intercepted => {
          const permitted = previewAssetAllowed(intercepted.url(), intercepted.method(), origin, renderer.paths)
          void (permitted ? intercepted.continue() : intercepted.abort()).catch(() => {})
        })
        await page.goto(new URL(renderer.entry, origin).href, { waitUntil: 'networkidle0', timeout: Math.min(timeoutMs, 15_000) })
        checkActive()
        await page.waitForFunction(() => typeof (globalThis as unknown as { renderAgentPreview?: unknown }).renderAgentPreview === 'function', { timeout: Math.min(timeoutMs, 10_000) })
        checkActive()
        const value = await page.evaluate(async input => {
          const render = (globalThis as unknown as { renderAgentPreview: (job: PreviewRenderJob) => Promise<unknown> }).renderAgentPreview
          const result = JSON.stringify(await render(input))
          // Bound the transfer inside the browser before CDP copies it into the Worker.
          if (result.length > 140_000) throw new Error('The renderer result exceeds its byte budget.')
          return result
        }, job)
        checkActive()
        return validateReply(value, job)
      }
      const rendering = render()
      background?.waitUntil(rendering.then(close, close))
      return response(200, await Promise.race([rendering, interrupted]))
    } catch (error) {
      if (error instanceof PreviewHttpError) return response(error.status, { error: error.code, message: error.message })
      // The provider's launch error has this documented status wrapper; never expose its raw body.
      if (error instanceof Error && /Unable to create new browser: code: 429:/.test(error.message))
        return response(429, { error: 'rate_limit', message: 'The browser provider is at its limit. Retry later.' }, '20')
      return response(502, { error: 'render_failed', message: 'The preview renderer could not complete this request.' })
    } finally {
      stopped = true
      clearTimeout(timer)
      if (abort) request.signal.removeEventListener('abort', abort)
      // Launch can complete after a deadline. Its continuation above closes that late browser.
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (acquisition && !browser ? acquisition.then(acquired => { browser = acquired; return close() }, () => {}) : close())
        .then(() => { active = false })
      background?.waitUntil(cleanup)
      await Promise.race([cleanup, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, cleanupMs) })])
      clearTimeout(cleanupTimer)
    }
  }
}

export const handleAgentPreview = createAgentPreviewHandler()

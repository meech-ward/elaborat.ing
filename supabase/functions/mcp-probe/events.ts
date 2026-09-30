// Temporary host capability probe, remove after testing.
//
// MCP Events for the probe server: one event (comment.created) that a host
// can list and subscribe to. A subscription is checked, its callback is
// verified with the signed challenge the events spec describes, and nothing is
// stored: the probe keeps no subscriptions and touches no data. After a new
// verification it sends one sample event, so a test can see whether delivery
// reaches the host. Each step writes one structured log line.
// https://developers.openai.com/plugins/build/mcp-events

import { ProtocolError } from 'npm:@modelcontextprotocol/server@2.0.0'
import { Webhook } from 'npm:standardwebhooks@1.1.1'
import { z } from 'npm:zod@4.4.3'

/** JSON-RPC error for a callback that could not be verified (events spec). */
export const CALLBACK_ENDPOINT_ERROR = -32015
const INVALID_PARAMS = -32602

/** How long a callback may take to answer, in milliseconds. */
export const CALLBACK_TIMEOUT_MS = 5_000
/** How long a verified callback stays verified. */
const VERIFIED_FOR_MS = 10 * 60_000
/** The longest subscription granted, and the shortest. */
const MAX_TTL_MS = 24 * 60 * 60_000
const MIN_TTL_MS = 60_000
/** Bytes of a callback's answer read at most. */
const MAX_ANSWER_BYTES = 16_384
/** The sample event goes out this long after the subscription is answered. */
export const SAMPLE_DELAY_MS = 3_000
/** Who subscribes: the probe has no sign-in, so everyone is the same principal. */
const PRINCIPAL = 'anonymous'

export const COMMENT_CREATED = {
  name: 'comment.created',
  description: 'A new comment was added to a file in the specified elaborat.ing project. Test event from a temporary probe.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID of the project to watch, from its address: https://elaborat.ing/projects/<id>.' },
      path: { type: 'string', description: 'Only comments on this file, by its path in the project.' },
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      path: { type: 'string' },
      comment_id: { type: 'string' },
      text: { type: 'string' },
      url: { type: 'string' },
    },
    required: ['project_id', 'path', 'comment_id', 'text', 'url'],
    additionalProperties: false,
  },
}

const argumentsSchema = z.strictObject({ project_id: z.string().min(1).max(200), path: z.string().min(1).max(1000).optional() })

const subscribeSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({ mode: z.string(), url: z.string(), secret: z.string() }),
  cursor: z.string().nullish(),
  ttlMs: z.number().nullish(),
})

const unsubscribeSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({ mode: z.string().optional(), url: z.string() }),
})

/** One structured log line per step. Never pass secrets, tokens or full callback URLs. */
export function log(step: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ probe: 'mcp-probe', step, ...fields }))
}

/** The callback's host, for logs, or null when the URL does not parse. */
export function callbackHost(raw: string): string | null {
  try {
    return new URL(raw).host
  } catch {
    return null
  }
}

/** Why a callback address is refused, or null when it may be called. */
export function callbackProblem(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'not_a_url'
  }
  if (url.protocol !== 'https:') return 'not_https'
  if (url.username || url.password) return 'has_credentials'
  if (url.port && url.port !== '443') return 'port_not_allowed'
  const host = url.hostname.toLowerCase()
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return 'ip_address'
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|home|lan)$/.test(host)) return 'local_host'
  return null
}

/** The signing key's length in bytes, or null when the secret is not a `whsec_` base64 key. */
export function secretBytes(secret: string): number | null {
  if (!secret.startsWith('whsec_')) return null
  try {
    return atob(secret.slice('whsec_'.length)).length
  } catch {
    return null
  }
}

/** JSON with object keys sorted, so equal arguments give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The same subscriber, callback, event and arguments always give the same id. */
export async function subscriptionId(url: string, name: string, args: unknown): Promise<string> {
  const text = canonicalJson([PRINCIPAL, url, name, args ?? {}])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return `sub_${base64url(digest.slice(0, 18))}`
}

function randomId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(18)))
}

/** Standard Webhooks headers for one signed POST. */
export function signedHeaders(secret: string, messageId: string, subscription: string, body: string, now = new Date()): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'webhook-id': messageId,
    'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
    'webhook-signature': new Webhook(secret).sign(messageId, now, body),
    'X-MCP-Subscription-Id': subscription,
  }
}

type Fetch = typeof fetch

/** POSTs a signed body to a callback: no redirects, a short timeout. */
async function post(fetcher: Fetch, url: string, headers: Record<string, string>, body: string): Promise<Response> {
  return await fetcher(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) })
}

async function readSome(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_ANSWER_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => {})
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes.slice(0, MAX_ANSWER_BYTES))
}

function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let difference = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return difference === 0
}

function failureReason(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable'
}

/**
 * Sends the signed verification challenge and checks the echo. Resolves to
 * null when the callback echoed it, or the reason it failed.
 */
export async function verifyCallback(fetcher: Fetch, url: string, secret: string, subscription: string): Promise<{ reason: string; status?: number } | null> {
  const challenge = randomId()
  const body = JSON.stringify({ type: 'verification', challenge })
  let response: Response
  try {
    response = await post(fetcher, url, signedHeaders(secret, `msg_verification_${randomId()}`, subscription, body), body)
  } catch (error) {
    return { reason: failureReason(error) }
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    return { reason: 'redirect_refused', status: response.status }
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {})
    return { reason: 'challenge_failed', status: response.status }
  }
  let echoed: unknown
  try {
    echoed = JSON.parse(await readSome(response))
  } catch (error) {
    return failureReason(error) === 'timeout' ? { reason: 'timeout' } : { reason: 'challenge_failed', status: response.status }
  }
  const value = echoed && typeof echoed === 'object' ? (echoed as { challenge?: unknown }).challenge : undefined
  return typeof value === 'string' && sameText(value, challenge) ? null : { reason: 'challenge_failed', status: response.status }
}

/** What the events handlers need from outside: the network, and a way to finish work after answering. */
export type EventsDeps = {
  fetch: Fetch
  /** Runs a promise after the response is sent (EdgeRuntime.waitUntil on Supabase). */
  background: (work: Promise<unknown>) => void
  /** Waits before the sample event; tests pass a shorter wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

/** Callbacks verified recently, by URL, with when that ends. Per function instance. */
const verified = new Map<string, number>()

/** Forgets verified callbacks (tests). */
export function forgetVerified(): void {
  verified.clear()
}

function invalid(message: string, outcome: string, fields: Record<string, unknown> = {}): never {
  log('subscribe', { outcome, ...fields })
  throw new ProtocolError(INVALID_PARAMS, message)
}

export async function listEvents(): Promise<{ events: unknown[] }> {
  log('events/list', { outcome: 'listed', events: [COMMENT_CREATED.name] })
  return { events: [COMMENT_CREATED] }
}

export async function subscribe(raw: unknown, deps: EventsDeps): Promise<{ id: string; refreshBefore: string; cursor: null; truncated: false }> {
  const now = deps.now?.() ?? new Date()
  const parsed = subscribeSchema.safeParse(raw)
  if (!parsed.success) invalid('events/subscribe needs name, arguments and delivery {mode, url, secret}.', 'bad_params')
  const params = parsed.data
  const host = callbackHost(params.delivery.url)
  const seen = { event: params.name, host, ttlMs: params.ttlMs, cursor: params.cursor === undefined ? 'absent' : params.cursor === null ? 'null' : 'set', argumentKeys: Object.keys(params.arguments ?? {}) }
  if (params.name !== COMMENT_CREATED.name) invalid(`Unknown event ${params.name}. This server has ${COMMENT_CREATED.name}.`, 'unknown_event', seen)
  const args = argumentsSchema.safeParse(params.arguments ?? {})
  if (!args.success) invalid('Arguments must be {project_id, path?}.', 'bad_arguments', seen)
  if (params.delivery.mode !== 'webhook') invalid('Only webhook delivery is supported.', 'bad_delivery_mode', { ...seen, mode: params.delivery.mode })
  const keyBytes = secretBytes(params.delivery.secret)
  if (keyBytes === null || keyBytes < 24 || keyBytes > 64) invalid('The secret must be whsec_ and base64 of 24 to 64 bytes.', 'bad_secret', { ...seen, keyBytes })

  const problem = callbackProblem(params.delivery.url)
  if (problem) {
    log('subscribe', { outcome: 'callback_refused', reason: problem, ...seen })
    throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'The callback address is not allowed.', { reason: problem })
  }

  const id = await subscriptionId(params.delivery.url, params.name, args.data)
  const cachedUntil = verified.get(params.delivery.url) ?? 0
  const fresh = cachedUntil <= now.getTime()
  if (fresh) {
    const started = Date.now()
    const failure = await verifyCallback(deps.fetch, params.delivery.url, params.delivery.secret, id)
    log('challenge', { outcome: failure ? 'failed' : 'verified', ...(failure ?? {}), host, ms: Date.now() - started })
    if (failure) throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'The callback did not answer the verification challenge.', failure)
    verified.set(params.delivery.url, now.getTime() + VERIFIED_FOR_MS)
  } else {
    log('challenge', { outcome: 'cached', host })
  }

  const ttl = params.ttlMs == null ? MAX_TTL_MS : Math.min(Math.max(params.ttlMs, MIN_TTL_MS), MAX_TTL_MS)
  const refreshBefore = new Date(now.getTime() + ttl).toISOString()
  log('subscribe', { outcome: 'subscribed', subscription: id, refreshBefore, ...seen })
  if (fresh) deps.background(sendSample(deps, params.delivery.url, params.delivery.secret, id, args.data))
  return { id, refreshBefore, cursor: null, truncated: false }
}

/** One sample comment.created, signed like a real delivery, sent once after a new verification. */
export async function sendSample(deps: EventsDeps, url: string, secret: string, subscription: string, args: { project_id: string; path?: string }): Promise<void> {
  await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(SAMPLE_DELAY_MS)
  const eventId = `evt_probe_${randomId()}`
  const path = args.path ?? 'welcome.mdx'
  const body = JSON.stringify({
    eventId,
    name: COMMENT_CREATED.name,
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
    data: {
      project_id: args.project_id,
      path,
      comment_id: `probe_${randomId()}`,
      text: 'Sample comment sent by the elaborat.ing probe to test delivery.',
      url: `https://elaborat.ing/projects/${encodeURIComponent(args.project_id)}`,
    },
    cursor: null,
  })
  const started = Date.now()
  try {
    const response = await post(deps.fetch, url, signedHeaders(secret, eventId, subscription, body), body)
    await response.body?.cancel().catch(() => {})
    log('delivery', { outcome: response.ok ? 'accepted' : 'rejected', status: response.status, host: callbackHost(url), subscription, ms: Date.now() - started })
  } catch (error) {
    log('delivery', { outcome: 'failed', reason: failureReason(error), host: callbackHost(url), subscription, ms: Date.now() - started })
  }
}

export async function unsubscribe(raw: unknown): Promise<Record<string, never>> {
  const parsed = unsubscribeSchema.safeParse(raw)
  if (!parsed.success) {
    log('unsubscribe', { outcome: 'bad_params' })
    throw new ProtocolError(INVALID_PARAMS, 'events/unsubscribe needs name, arguments and delivery {url}.')
  }
  const { name, delivery } = parsed.data
  const args = argumentsSchema.safeParse(parsed.data.arguments ?? {})
  const id = await subscriptionId(delivery.url, name, args.success ? args.data : parsed.data.arguments ?? {})
  log('unsubscribe', { outcome: 'stopped', event: name, host: callbackHost(delivery.url), subscription: id })
  return {}
}

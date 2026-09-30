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
import { z } from 'npm:zod@4.4.3'

import { CallbackError, callbackProblem, type Post } from '../_shared/callbacks.ts'
import {
  CALLBACK_ENDPOINT_ERROR,
  canonicalJson,
  INVALID_PARAMS,
  randomId,
  secretBytes,
  signedHeaders,
  subscriptionId as sharedSubscriptionId,
  verifyCallback as verifyWith,
} from '../_shared/events.ts'

export { CALLBACK_ENDPOINT_ERROR, callbackProblem, canonicalJson }

/** How long a callback may take to answer, in milliseconds. */
export const CALLBACK_TIMEOUT_MS = 5_000
/** How long a verified callback stays verified. */
const VERIFIED_FOR_MS = 10 * 60_000
/** The longest subscription granted, and the shortest. */
const MAX_TTL_MS = 24 * 60 * 60_000
const MIN_TTL_MS = 60_000
/** Bytes of a callback's answer read at most. */
const MAX_ANSWER_BYTES = 16_384
/** Challenges running at once, per function instance, at most; more subscribes fail as busy. */
const MAX_CHALLENGES_IN_FLIGHT = 2
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

/** The same callback, event and arguments always give the same id. */
export function subscriptionId(url: string, name: string, args: unknown): Promise<string> {
  return sharedSubscriptionId(PRINCIPAL, url, name, args)
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

function failureReason(error: unknown): 'timeout' | 'unreachable' {
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable'
}

/** The probe's callbacks go through `fetch`, as they always have; the production server pins addresses. */
function fetchPost(fetcher: Fetch): Post {
  return async (url, headers, body) => {
    let response: Response
    try {
      response = await post(fetcher, url, headers, body)
    } catch (error) {
      throw new CallbackError(failureReason(error))
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {})
      return { status: response.status, body: '' }
    }
    try {
      return { status: response.status, body: await readSome(response) }
    } catch (error) {
      throw new CallbackError(failureReason(error))
    }
  }
}

/**
 * Sends the signed verification challenge and checks the echo. Resolves to
 * null when the callback echoed it, or the reason it failed.
 */
export function verifyCallback(fetcher: Fetch, url: string, secret: string, subscription: string): ReturnType<typeof verifyWith> {
  return verifyWith(fetchPost(fetcher), url, secret, subscription)
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
let challengesInFlight = 0

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
    if (challengesInFlight >= MAX_CHALLENGES_IN_FLIGHT) {
      log('challenge', { outcome: 'busy', host })
      throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'Other callbacks are being verified. Try again shortly.', { reason: 'busy' })
    }
    const started = Date.now()
    challengesInFlight++
    let failure: Awaited<ReturnType<typeof verifyCallback>>
    try {
      failure = await verifyCallback(deps.fetch, params.delivery.url, params.delivery.secret, id)
    } finally {
      challengesInFlight--
    }
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

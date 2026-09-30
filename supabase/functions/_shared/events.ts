// MCP Events: the parts every server needs, whatever its events are.
// Subscription ids, signing secrets, Standard Webhooks signatures and the
// signed verification challenge a callback must answer before it gets any
// data. https://developers.openai.com/plugins/build/mcp-events

import { Webhook } from 'npm:standardwebhooks@1.1.1'

import { CallbackError, type Post } from './callbacks.ts'

/** JSON-RPC error for a callback that is refused or did not verify. */
export const CALLBACK_ENDPOINT_ERROR = -32015
/** JSON-RPC error for bad parameters. */
export const INVALID_PARAMS = -32602
/** The largest event body a callback accepts. */
export const MAX_EVENT_BYTES = 256 * 1024

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

/** A random id, 24 characters of base64url. */
export function randomId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(18)))
}

/**
 * The subscription id: the same subscriber (`principal`), callback, event and
 * arguments always give the same one, whatever order the arguments' keys are in.
 */
export async function subscriptionId(principal: unknown, url: string, name: string, args: unknown): Promise<string> {
  const text = canonicalJson([principal, url, name, args ?? {}])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return `sub_${base64url(digest.slice(0, 18))}`
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

/** Whether a secret is one the events spec allows: `whsec_` and base64 of 24 to 64 bytes. */
export function validSecret(secret: string): boolean {
  const bytes = secretBytes(secret)
  return bytes !== null && bytes >= 24 && bytes <= 64
}

/**
 * Standard Webhooks headers for one signed POST. With more than one secret
 * (while a replaced one is still honoured), the body is signed with each, and
 * the signatures are sent space-separated.
 */
export function signedHeaders(secrets: string | string[], messageId: string, subscription: string, body: string, now = new Date()): Record<string, string> {
  const keys = typeof secrets === 'string' ? [secrets] : secrets
  return {
    'Content-Type': 'application/json',
    'webhook-id': messageId,
    'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
    'webhook-signature': keys.map((key) => new Webhook(key).sign(messageId, now, body)).join(' '),
    'X-MCP-Subscription-Id': subscription,
  }
}

/** Compares two strings in time that depends only on their lengths. */
export function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let difference = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return difference === 0
}

/** Why a callback did not verify, and its status when it answered. */
export type VerificationFailure = { reason: string; status?: number }

/**
 * Sends the signed verification challenge and checks the echo. Resolves to
 * null when the callback echoed it, or to why it did not: a redirect, an
 * answer that is not 2xx or not the challenge, or why it could not be reached.
 */
export async function verifyCallback(post: Post, url: string, secret: string, subscription: string): Promise<VerificationFailure | null> {
  const challenge = randomId()
  const body = JSON.stringify({ type: 'verification', challenge })
  let answer
  try {
    answer = await post(url, signedHeaders(secret, `msg_verification_${randomId()}`, subscription, body), body)
  } catch (error) {
    return { reason: error instanceof CallbackError ? error.reason : 'unreachable' }
  }
  if (answer.status >= 300 && answer.status < 400) return { reason: 'redirect_refused', status: answer.status }
  if (answer.status < 200 || answer.status >= 300) return { reason: 'challenge_failed', status: answer.status }
  let echoed: unknown
  try {
    echoed = JSON.parse(answer.body)
  } catch {
    return { reason: 'challenge_failed', status: answer.status }
  }
  const value = echoed && typeof echoed === 'object' ? (echoed as { challenge?: unknown }).challenge : undefined
  return typeof value === 'string' && sameText(value, challenge) ? null : { reason: 'challenge_failed', status: answer.status }
}

/** At most `limit` callbacks verified at once per function instance; the rest are refused as busy. */
export function challengeGate(limit: number): <T>(work: () => Promise<T>) => Promise<T | 'busy'> {
  let running = 0
  return async (work) => {
    if (running >= limit) return 'busy'
    running++
    try {
      return await work()
    } finally {
      running--
    }
  }
}

// Sign in with ChatGPT for plan usage, the protocol pieces: one sign-in
// transaction (state, PKCE S256 and nonce, used once, ten minutes), the
// authorization URL, the callback, the code exchange with the ID token
// checked, the granted-scope check, refresh and revoke. Written from
// OpenAI's public documentation, with fetch and Web Crypto only, so the
// local token keeper (Bun or Node) and a hosted function (Deno) share it.

export const ISSUER = 'https://auth.openai.com'
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
export const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`
export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
/** The resource every authorization, exchange and refresh names, and where inference goes. */
export const RESOURCE = 'https://api.openai.com/v1'
/** The scope that allows inference on the person's ChatGPT plan. Without it, plan use stays off. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE]
/** The client id a first sign-in registers through; the callback returns the issued one to keep. */
export const DYNAMIC_CLIENT = 'dynamic_agent_client'
export const AGENT_NAME = 'elaborat.ing'
export const TRANSACTION_MS = 10 * 60 * 1000
/** Clock skew allowed on the ID token's expiry. */
const SKEW_MS = 5_000

/** fetch, or a stand-in for it in tests. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Something about signing in went wrong. `code` is what the app shows; the message is for logs and the page. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Whether the saved tokens can never work again (a refresh token refused for good). */
    readonly terminal = false,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** The S256 challenge for a PKCE verifier: base64url of its SHA-256, no padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

/** A new host's id, made once and kept: a UUID URN, as OpenAI accepts. */
export const newHostId = (): string => `urn:uuid:${crypto.randomUUID()}`

/** One sign-in attempt, kept until its callback, at most ten minutes, and used once. */
export type Transaction = {
  state: string
  verifier: string
  nonce: string
  redirectUri: string
  /** The client id the request named: dynamic_agent_client on a first sign-in, the issued one after. */
  clientId: string
  /** Where the app goes back to once the callback is done: a path on its own origin. */
  returnTo: string
  expiresAt: number
}

export interface TransactionStore {
  put(transaction: Transaction): Promise<void>
  /** The transaction for this state, removed so it is never used twice; null when missing or expired. */
  take(state: string): Promise<Transaction | null>
}

/** Transactions in memory, for the local keeper (one process, one person). */
export function memoryTransactions(now: () => number = Date.now): TransactionStore {
  const pending = new Map<string, Transaction>()
  return {
    put(transaction) {
      for (const [state, entry] of pending) if (entry.expiresAt <= now()) pending.delete(state)
      pending.set(transaction.state, transaction)
      return Promise.resolve()
    },
    take(state) {
      const transaction = pending.get(state) ?? null
      pending.delete(state)
      return Promise.resolve(transaction && transaction.expiresAt > now() ? transaction : null)
    },
  }
}

export function newTransaction(input: { redirectUri: string; clientId: string; returnTo: string }, now: number): Transaction {
  return { ...input, state: randomToken(), verifier: randomToken(48), nonce: randomToken(), expiresAt: now + TRANSACTION_MS }
}

/**
 * The authorization URL for a transaction. A first sign-in registers through
 * dynamic_agent_client with the app's name; later ones use the issued client
 * id, with the saved email as a hint. `consent` asks again for every scope,
 * for someone who declined plan use before.
 */
export async function authorizeUrl(
  transaction: Transaction,
  options: { hostId: string; loginHint?: string | null; consent?: boolean },
): Promise<string> {
  const firstSignIn = transaction.clientId === DYNAMIC_CLIENT
  const params = new URLSearchParams({
    client_id: transaction.clientId,
    ...(firstSignIn ? { agent_name_hint: AGENT_NAME } : {}),
    ext_agent_host_id: options.hostId,
    ...(!firstSignIn && options.loginHint ? { login_hint: options.loginHint } : {}),
    response_type: 'code',
    redirect_uri: transaction.redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge_method: 'S256',
    code_challenge: await pkceChallenge(transaction.verifier),
    ...(options.consent ? { prompt: 'consent' } : {}),
  })
  return `${AUTHORIZE_URL}?${params}`
}

/**
 * The callback's code and the client id to exchange it with, once its state
 * matches a live transaction (which is used up either way). A first
 * sign-in's callback must carry the issued client id; a later one may leave
 * it out, and must not name another.
 */
export async function readCallback(url: URL, transactions: TransactionStore): Promise<{ code: string; clientId: string; transaction: Transaction }> {
  const state = url.searchParams.get('state')
  const transaction = state ? await transactions.take(state) : null
  if (!transaction) throw new OAuthError('invalid_state', 'This sign-in could not be verified, or took longer than ten minutes. Start again.')
  const error = url.searchParams.get('error')
  if (error) throw new OAuthError(error === 'access_denied' ? 'access_denied' : 'authorization_failed', error === 'access_denied' ? 'ChatGPT was not connected.' : `ChatGPT sign-in failed: ${error}.`)
  const code = url.searchParams.get('code')
  if (!code) throw new OAuthError('authorization_failed', 'The callback had no authorization code.')
  const returned = url.searchParams.get('client_id')
  let clientId = transaction.clientId
  if (transaction.clientId === DYNAMIC_CLIENT) {
    if (!returned || returned === DYNAMIC_CLIENT) throw new OAuthError('authorization_failed', 'ChatGPT did not finish registering elaborat.ing. Start again.')
    clientId = returned
  } else if (returned && returned !== transaction.clientId) {
    throw new OAuthError('authorization_failed', 'The callback named another client. Start again.')
  }
  return { code, clientId, transaction }
}

/** What the token endpoint returns, as the keeper keeps it. */
export type TokenSet = {
  access_token: string
  refresh_token: string
  id_token: string | null
  /** Milliseconds since the epoch. */
  expires_at: number
  /** Not refreshed before this time (milliseconds), or null. */
  earliest_refresh_at: number | null
  scopes: string[]
  saved_at: string
}

/** A time the token response gives as seconds, milliseconds or an ISO date, in milliseconds. */
function timeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value) {
    const parsed = /^\d+$/.test(value) ? timeOf(Number(value)) : Date.parse(value)
    return parsed !== null && Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** The error code an OAuth or API error body carries, in either of the shapes OpenAI uses. */
export function errorCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  if (record.error && typeof record.error === 'object') {
    const code = (record.error as Record<string, unknown>).code
    if (typeof code === 'string') return code
  }
  return typeof record.code === 'string' ? record.code : null
}

/** Refresh errors after which the saved tokens can never work again: sign in again. */
const TERMINAL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client'])

async function tokenRequest(fetcher: Fetch, form: Record<string, string>, now: number, previous: TokenSet | null): Promise<TokenSet> {
  let response: Response
  try {
    response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    })
  } catch {
    throw new OAuthError('unavailable', 'ChatGPT could not be reached.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code = errorCodeOf(body) ?? `http_${response.status}`
    const terminal = TERMINAL.has(code)
    throw new OAuthError(terminal ? 'reconnect' : response.status >= 500 ? 'unavailable' : code, `The token request failed: ${code}.`, terminal)
  }
  const tokens = (body ?? {}) as Record<string, unknown>
  if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    throw new OAuthError('authorization_failed', 'The token response had no access or refresh token.')
  }
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600
  const scope = typeof tokens.scope === 'string' ? tokens.scope : previous?.scopes.join(' ') ?? ''
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: typeof tokens.id_token === 'string' ? tokens.id_token : previous?.id_token ?? null,
    expires_at: now + expiresIn * 1000,
    earliest_refresh_at: timeOf(tokens.earliest_refresh_at),
    scopes: scope.split(' ').filter(Boolean).sort(),
    saved_at: new Date(now).toISOString(),
  }
}

/** Exchanges a callback's code, with the transaction's verifier and the exact redirect it named. No secret: a public client. */
export function exchangeCode(fetcher: Fetch, input: { code: string; clientId: string; transaction: Transaction }, now: number): Promise<TokenSet> {
  return tokenRequest(
    fetcher,
    {
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.transaction.verifier,
      redirect_uri: input.transaction.redirectUri,
      resource: RESOURCE,
    },
    now,
    null,
  )
}

/** A new token set from the refresh token, with the issued client id. The refresh token rotates: keep the new one. */
export function refreshTokens(fetcher: Fetch, input: { clientId: string; tokens: TokenSet }, now: number): Promise<TokenSet> {
  return tokenRequest(fetcher, { grant_type: 'refresh_token', client_id: input.clientId, refresh_token: input.tokens.refresh_token, resource: RESOURCE }, now, input.tokens)
}

/** Ends the renewable session. True when OpenAI confirmed it (an empty 200, also for a token that was already invalid). */
export async function revokeToken(fetcher: Fetch, input: { clientId: string; refreshToken: string }): Promise<boolean> {
  try {
    const response = await fetcher(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: input.refreshToken, token_type_hint: 'refresh_token', client_id: input.clientId }),
    })
    return response.ok
  } catch {
    return false
  }
}

export const planAllowed = (scopes: readonly string[]): boolean => scopes.includes(PLAN_SCOPE)

type Jwk = JsonWebKey & { kid?: string }
const jwksCache = new Map<Fetch, { keys: Jwk[]; at: number }>()

async function signingKey(fetcher: Fetch, kid: string | undefined, now: number): Promise<Jwk | null> {
  const find = (keys: Jwk[]) => keys.find((key) => key.kty === 'RSA' && (kid === undefined || key.kid === kid)) ?? null
  const cached = jwksCache.get(fetcher)
  if (cached && now - cached.at < 3_600_000) {
    const key = find(cached.keys)
    if (key) return key
  }
  const response = await fetcher(JWKS_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new OAuthError('unavailable', 'OpenAI signing keys could not be loaded.')
  const body = (await response.json()) as { keys?: Jwk[] }
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache.set(fetcher, { keys, at: now })
  return find(keys)
}

const decodeJson = (part: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(fromBase64url(part)))

/**
 * Checks an ID token as OpenAI's guide says: its RS256 signature against
 * OpenAI's published keys, the issuer, the audience (the issued client id),
 * the expiry and this sign-in's nonce. Returns its subject and email.
 */
export async function verifyIdToken(
  fetcher: Fetch,
  idToken: string,
  expected: { clientId: string; nonce: string },
  now: number,
): Promise<{ sub: string; email: string | null }> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new OAuthError('invalid_id_token', 'The ID token is not a JWT.')
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = decodeJson(parts[0])
    payload = decodeJson(parts[1])
  } catch {
    throw new OAuthError('invalid_id_token', 'The ID token could not be read.')
  }
  if (header.alg !== 'RS256') throw new OAuthError('invalid_id_token', 'The ID token is not signed with RS256.')
  const jwk = await signingKey(fetcher, typeof header.kid === 'string' ? header.kid : undefined, now)
  if (!jwk) throw new OAuthError('invalid_id_token', "The ID token's signing key is unknown.")
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!signed) throw new OAuthError('invalid_id_token', 'The ID token signature does not match.')
  if (payload.iss !== ISSUER) throw new OAuthError('invalid_id_token', 'The ID token has another issuer.')
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audience.includes(expected.clientId)) throw new OAuthError('invalid_id_token', 'The ID token is for another client.')
  if (typeof payload.exp !== 'number' || payload.exp * 1000 + SKEW_MS <= now) throw new OAuthError('invalid_id_token', 'The ID token has expired.')
  if (payload.nonce !== expected.nonce) throw new OAuthError('invalid_id_token', 'The ID token nonce does not match this sign-in.')
  if (typeof payload.sub !== 'string' || !payload.sub) throw new OAuthError('invalid_id_token', 'The ID token has no subject.')
  return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : null }
}

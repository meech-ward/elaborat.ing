// The token keeper: holds the person's ChatGPT tokens so the browser never
// does, refreshes them one at a time, and answers the app's /chatgpt/*
// requests and the sign-in's /auth/callback. The local keeper runs it in
// the dev server (vite-plugins/chatgpt-keeper.ts) with a credential file;
// a hosted function can run the same code with another store.
import {
  DYNAMIC_CLIENT,
  exchangeCode,
  memoryTransactions,
  newHostId,
  newTransaction,
  OAuthError,
  planAllowed,
  readCallback,
  refreshTokens,
  revokeToken,
  verifyIdToken,
  authorizeUrl,
  type Fetch,
  type TokenSet,
  type TransactionStore,
} from './oauth.ts'
import { buildResponsesRequest, listedModels, MAX_REQUEST_BYTES, MODELS_URL, planErrorFor, RESPONSES_URL, type PlanError, type PlanErrorCode, type PlanModel } from './responses.ts'

/** What the keeper keeps: this host's id, the issued client and account, and the tokens while connected. */
export type Credentials = {
  ext_agent_host_id: string
  client_id: string | null
  email: string | null
  subject: string | null
  /** The tokens stopped working for good (a refresh was refused): connect again. */
  reconnect: boolean
  tokens: TokenSet | null
}

export interface CredentialStore {
  read(): Promise<Credentials | null>
  write(credentials: Credentials): Promise<void>
}

/** What the app may know about the connection. Never a token. */
export type PlanStatus = {
  connected: boolean
  /** The person allowed plan use (the chatgpt.tokens.use.direct scope). */
  plan: boolean
  email: string | null
  models: PlanModel[]
  problem: PlanErrorCode | null
}

/** An OpenAI answer that was an error, as the app shows it. */
export class PlanFailure extends Error {
  constructor(readonly planError: PlanError) {
    super(planError.message)
    this.name = 'PlanFailure'
  }
}

/** The access token is refreshed this long before it expires. */
const REFRESH_EARLY_MS = 60_000
const MODELS_MS = 10 * 60_000
/** Plan use needs the chatgpt.tokens.use.direct scope; without it, connecting again with consent turns it on. */
const PLAN_OFF: PlanError = { error: 'reconnect', message: 'Reconnect ChatGPT and allow plan use to continue.' }

export const STATUS_FOR: Record<PlanErrorCode, number> = { not_eligible: 403, usage_limit: 429, unavailable: 503, reconnect: 401, error: 502 }

/** An error as the app's error code and message. */
function planErrorOf(error: unknown): PlanError {
  if (error instanceof PlanFailure) return error.planError
  if (error instanceof OAuthError) {
    if (error.terminal || error.code === 'reconnect' || error.code === 'not_connected') return { error: 'reconnect', message: 'Reconnect ChatGPT to continue.' }
    return { error: 'unavailable', message: 'ChatGPT plan usage is unavailable right now.' }
  }
  return { error: 'unavailable', message: 'ChatGPT plan usage is unavailable right now.' }
}

export class PlanKeeper {
  private pending: Promise<string> | null = null
  /** Credential changes (a refresh, a sign-in's save, a disconnect) run one at a time, in this order. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Goes up on each disconnect: a refresh asked for before it drops its new tokens. */
  private generation = 0
  private modelCache: { models: PlanModel[]; at: number } | null = null
  private readonly transactions: TransactionStore
  private readonly fetcher: Fetch
  private readonly now: () => number

  constructor(private readonly options: { store: CredentialStore; transactions?: TransactionStore; fetch?: Fetch; now?: () => number }) {
    this.now = options.now ?? Date.now
    this.transactions = options.transactions ?? memoryTransactions(this.now)
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /**
   * The saved credentials, read each time so a deleted file means not
   * connected; the first time, a new host id, saved before any sign-in.
   */
  private async load(): Promise<Credentials> {
    const saved = await this.options.store.read()
    if (saved) return saved
    const created: Credentials = { ext_agent_host_id: newHostId(), client_id: null, email: null, subject: null, reconnect: false, tokens: null }
    await this.save(created)
    return created
  }

  private async save(credentials: Credentials) {
    await this.options.store.write(credentials)
  }

  private serial<T>(change: () => Promise<T>): Promise<T> {
    const run = this.queue.then(change)
    this.queue = run.catch(() => {})
    return run
  }

  /** The URL that starts a sign-in, which comes back to `redirectUri` and then to `returnTo`. */
  async start(input: { redirectUri: string; returnTo: string; consent?: boolean }): Promise<string> {
    const credentials = await this.load()
    const transaction = newTransaction({ redirectUri: input.redirectUri, clientId: credentials.client_id ?? DYNAMIC_CLIENT, returnTo: input.returnTo }, this.now())
    await this.transactions.put(transaction)
    return authorizeUrl(transaction, { hostId: credentials.ext_agent_host_id, loginHint: credentials.email, consent: input.consent })
  }

  /** Completes a sign-in from its callback URL: checks it, exchanges the code, checks the ID token, keeps the tokens. */
  async finish(url: URL): Promise<{ returnTo: string; plan: boolean }> {
    const callback = await readCallback(url, this.transactions)
    const tokens = await exchangeCode(this.fetcher, callback, this.now())
    if (!tokens.id_token) throw new OAuthError('invalid_id_token', 'The token response had no ID token.')
    const identity = await verifyIdToken(this.fetcher, tokens.id_token, { clientId: callback.clientId, nonce: callback.transaction.nonce }, this.now())
    // After any refresh already running, so its save cannot replace this sign-in.
    await this.serial(async () => {
      const credentials = await this.load()
      if (callback.transaction.clientId !== DYNAMIC_CLIENT && credentials.subject && credentials.subject !== identity.sub) {
        throw new OAuthError('authorization_failed', 'That is a different ChatGPT account from the one connected before.')
      }
      await this.save({ ...credentials, client_id: callback.clientId, email: identity.email, subject: identity.sub, reconnect: false, tokens })
    })
    this.modelCache = null
    return { returnTo: callback.transaction.returnTo, plan: planAllowed(tokens.scopes) }
  }

  /**
   * A usable access token for plan use, refreshed when it is about to expire
   * (not before earliest_refresh_at). Callers at the same time share one
   * refresh, and the rotated refresh token is saved before the new access
   * token is used. Without the plan scope it is refused before any request.
   */
  accessToken(): Promise<string> {
    const generation = this.generation
    this.pending ??= this.serial(() => this.currentToken(generation)).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async currentToken(generation: number): Promise<string> {
    const credentials = await this.load()
    const tokens = credentials.tokens
    if (!tokens || !credentials.client_id) throw new OAuthError(credentials.reconnect ? 'reconnect' : 'not_connected', 'ChatGPT is not connected.')
    if (!planAllowed(tokens.scopes)) throw new PlanFailure(PLAN_OFF)
    const now = this.now()
    const fresh = now < tokens.expires_at - REFRESH_EARLY_MS
    const tooEarly = tokens.earliest_refresh_at !== null && now < tokens.earliest_refresh_at && now < tokens.expires_at
    if (fresh || tooEarly) return tokens.access_token
    let next: TokenSet
    try {
      next = await refreshTokens(this.fetcher, { clientId: credentials.client_id, tokens }, now)
    } catch (error) {
      // A refresh token refused for good (reused, expired, revoked): connect again.
      if (error instanceof OAuthError && error.terminal && generation === this.generation) await this.save({ ...credentials, tokens: null, reconnect: true })
      throw error
    }
    if (generation !== this.generation) {
      // Disconnected while this refresh ran: end the new session instead of keeping it.
      await revokeToken(this.fetcher, { clientId: credentials.client_id, refreshToken: next.refresh_token })
      throw new OAuthError('not_connected', 'ChatGPT is not connected.')
    }
    await this.save({ ...credentials, tokens: next })
    if (!planAllowed(next.scopes)) throw new PlanFailure(PLAN_OFF)
    return next.access_token
  }

  /** The account's models with visibility "list", kept for ten minutes. */
  async models(): Promise<PlanModel[]> {
    if (this.modelCache && this.now() - this.modelCache.at < MODELS_MS) return this.modelCache.models
    const token = await this.accessToken()
    let response: Response
    try {
      response = await this.fetcher(MODELS_URL, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
    } catch {
      throw new PlanFailure({ error: 'unavailable', message: 'ChatGPT plan usage is unavailable right now.' })
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new PlanFailure(planErrorFor(response.status, body))
    const models = listedModels(body)
    this.modelCache = { models, at: this.now() }
    return models
  }

  async status(): Promise<PlanStatus> {
    const credentials = await this.load()
    const base = { email: credentials.email, models: [] as PlanModel[], problem: null as PlanErrorCode | null }
    if (!credentials.tokens) return { ...base, connected: false, plan: false, problem: credentials.reconnect ? 'reconnect' : null }
    if (!planAllowed(credentials.tokens.scopes)) return { ...base, connected: true, plan: false }
    try {
      return { ...base, connected: true, plan: true, models: await this.models() }
    } catch (error) {
      const connected = (await this.load()).tokens !== null
      return { ...base, connected, plan: connected, problem: connected ? planErrorOf(error).error : 'reconnect' }
    }
  }

  /** Sends the browser's `{ model, input }` on as the pinned Responses request, and streams the answer back. */
  async responses(body: unknown, signal?: AbortSignal): Promise<Response> {
    let models: PlanModel[]
    let token: string
    try {
      models = await this.models()
      token = await this.accessToken()
    } catch (error) {
      return failure(planErrorOf(error))
    }
    const built = buildResponsesRequest(body, models.map((model) => model.slug))
    if (!built.ok) return json(400, { error: 'error', message: built.message })
    let upstream: Response
    try {
      upstream = await this.fetcher(RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(built.request),
        signal,
      })
    } catch {
      return failure({ error: 'unavailable', message: 'ChatGPT could not be reached.' })
    }
    if (!upstream.ok) return failure(planErrorFor(upstream.status, await upstream.json().catch(() => null)))
    return new Response(upstream.body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
  }

  /**
   * Revokes the renewable session and forgets the tokens; the client and host
   * ids stay for the next sign-in. A refresh already running finishes first
   * and revokes its new tokens instead of saving them.
   */
  async disconnect(): Promise<{ revoked: boolean }> {
    this.generation++
    return this.serial(async () => {
      const credentials = await this.load()
      const revoked = credentials.tokens && credentials.client_id ? await revokeToken(this.fetcher, { clientId: credentials.client_id, refreshToken: credentials.tokens.refresh_token }) : true
      await this.save({ ...credentials, tokens: null, reconnect: false })
      this.modelCache = null
      return { revoked }
    })
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const failure = (error: PlanError) => json(STATUS_FOR[error.error], error)

/** A path on the app's own origin to come back to, or "/". */
function safeReturn(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/'
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

function callbackProblem(message: string): Response {
  const page =
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>ChatGPT not connected</title><body style="font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem">' +
    `<h1 style="font-size:20px">ChatGPT was not connected</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to elaborat.ing</a></p></body></html>`
  return new Response(page, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * The keeper's HTTP side: POST /chatgpt/{start,status,responses,disconnect}
 * and GET /auth/callback. Every /chatgpt/ request must come from the app's
 * own origin (`origin`) as JSON, so another site can never use the person's
 * plan. Returns null for any other path.
 */
export function keeperHandler(keeper: PlanKeeper, options: { origin: () => string }): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url)
    const origin = options.origin()
    if (url.pathname === '/auth/callback') {
      if (request.method !== 'GET') return json(405, { error: 'error', message: 'Use GET.' })
      try {
        const { returnTo } = await keeper.finish(url)
        return new Response(null, { status: 303, headers: { location: returnTo, 'cache-control': 'no-store' } })
      } catch (error) {
        return callbackProblem(error instanceof OAuthError ? error.message : 'Something went wrong. Start again.')
      }
    }
    if (!url.pathname.startsWith('/chatgpt/')) return null
    if (request.method !== 'POST') return json(405, { error: 'error', message: 'Use POST.' })
    if (request.headers.get('origin') !== origin) return json(403, { error: 'error', message: `Open elaborat.ing at ${origin} to use your ChatGPT plan.` })
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json(415, { error: 'error', message: 'Send JSON.' })
    const text = await request.text()
    if (text.length > MAX_REQUEST_BYTES) return json(413, { error: 'error', message: 'This chat is too long. Start a new chat.' })
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text || '{}')
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return json(400, { error: 'error', message: 'Send JSON.' })
    }
    switch (url.pathname) {
      case '/chatgpt/start':
        return json(200, { url: await keeper.start({ redirectUri: `${origin}/auth/callback`, returnTo: safeReturn(body.return_to), consent: body.consent === true }) })
      case '/chatgpt/status':
        return json(200, await keeper.status())
      case '/chatgpt/responses':
        return keeper.responses(body, request.signal)
      case '/chatgpt/disconnect':
        return json(200, await keeper.disconnect())
      default:
        return json(404, { error: 'error', message: 'Not found.' })
    }
  }
}

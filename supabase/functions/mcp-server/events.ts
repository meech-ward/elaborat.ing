// MCP Events: a connected agent watches a project, or one file, for the
// comments its person asks it about (comment.created). The events spec's
// three methods, on the same signed-in endpoint as the tools, as custom
// handlers on the SDK's Server, which has no events support of its own.
// https://developers.openai.com/plugins/build/mcp-events
//
// A subscription belongs to the person and the agent (OAuth client) that made
// it. It is checked (the person can read the project, the file exists, they
// have room for another), its callback is verified with the signed challenge,
// and then stored with its secret in Vault by service-only database functions
// (supabase/schemas/events.sql), which check it all again. The database
// queues matching comments and the send-events function delivers them.

import { type McpServer, ProtocolError, type ServerCapabilities } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { callbackProblem, type Post } from '../_shared/callbacks.ts'
import {
  CALLBACK_ENDPOINT_ERROR,
  challengeGate,
  INVALID_PARAMS,
  subscriptionId,
  validSecret,
  verifyCallback,
} from '../_shared/events.ts'

/**
 * Declared on the server, so server/discover advertises events. `events` is
 * not in the SDK's capability type yet; discover returns capabilities as declared.
 */
export const EVENT_CAPABILITIES: ServerCapabilities & { events: Record<string, never> } = { events: {} }

/** JSON-RPC error for a per-user limit reached. */
const LIMIT_REACHED = -32029

export const COMMENT_CREATED = {
  name: 'comment.created',
  description:
    'A comment the user asked an agent about in an elaborat.ing project: a new thread they started with Ask an agent on, ' +
    'or their reply on their own open thread that has it on. Only the user\'s own comments, never other people\'s or an agent\'s. ' +
    'Each event has the thread and a short excerpt; read the file and the thread with read_file and list_comments before acting.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'The project to watch, from list_projects.' },
      path: { type: 'string', description: 'Only comments on this file, such as notes/plan.md. Leave it out for the whole project.' },
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      path: { type: 'string', description: 'The file the thread is on.' },
      thread_id: { type: 'string' },
      comment_id: { type: 'string' },
      quote: { type: 'string', description: 'What the thread is on: quoted text, a heading or a drawing element. Empty for the whole file.' },
      text: { type: 'string', description: 'The start of the comment, at most 500 characters.' },
      url: { type: 'string', description: 'The file in the app.' },
    },
    required: ['project_id', 'path', 'thread_id', 'comment_id', 'quote', 'text', 'url'],
    additionalProperties: false,
  },
}

const argumentsSchema = z.strictObject({ project_id: z.uuid(), path: z.string().min(1).max(1024).optional() })

const subscribeSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({ mode: z.string(), url: z.string(), secret: z.string() }),
  cursor: z.string().nullish(),
  ttlMs: z.number().nonnegative().nullish(),
})

const unsubscribeSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({ mode: z.string().optional(), url: z.string() }),
})

type DbError = { code?: string; message: string } | null

/** What the events methods need: who is calling, and the database and network. */
export type EventsContext = {
  userId: string
  /** The OAuth client (agent) the caller's token was issued to, or null for a person's own session. */
  clientId: string | null
  /** Counts the call against the person's agent tool calls a minute, as the person. */
  countCall: () => PromiseLike<{ error: DbError }>
  /** Calls a service-only database function (the service role client). */
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: DbError }>
  /** POSTs to a callback, checking its address each time (postToCallback). */
  post: Post
}

/** One structured log line per step. Never pass secrets, tokens or full callback URLs. */
function log(step: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ events: 'mcp-server', step, ...fields }))
}

function callbackHost(raw: string): string | null {
  try {
    return new URL(raw).host
  } catch {
    return null
  }
}

/** Challenges running at once in this function instance, at most. */
const gate = challengeGate(2)

function invalid(message: string): never {
  throw new ProtocolError(INVALID_PARAMS, message)
}

/** A database refusal as the agent should see it; anything unexpected is an internal error. */
function refused(error: NonNullable<DbError>, step: string): never {
  log(step, { outcome: 'refused', code: error.code })
  if (error.code === 'PT429') throw new ProtocolError(LIMIT_REACHED, error.message)
  if (error.code === '42501' || error.code === '22023' || error.code === '54000') invalid(error.message)
  throw new Error(`${step} failed`)
}

function listEvents() {
  return { events: [COMMENT_CREATED] }
}

async function subscribe(raw: unknown, context: EventsContext) {
  const parsed = subscribeSchema.safeParse(raw)
  if (!parsed.success) invalid('events/subscribe needs name, arguments and delivery {mode, url, secret}.')
  const params = parsed.data
  if (params.name !== COMMENT_CREATED.name) invalid(`Unknown event ${params.name}. This server has ${COMMENT_CREATED.name}.`)
  const args = argumentsSchema.safeParse(params.arguments ?? {})
  if (!args.success) invalid('Arguments are {project_id, path?}: a project id from list_projects, and a file path in it.')
  if (params.delivery.mode !== 'webhook') invalid('Only webhook delivery is supported.')
  if (!validSecret(params.delivery.secret)) invalid('The secret must be whsec_ and base64 of 24 to 64 bytes.')
  if (!context.clientId) invalid('Only a connected agent can subscribe to events.')

  const url = params.delivery.url
  const host = callbackHost(url)
  const problem = callbackProblem(url)
  if (problem) {
    log('subscribe', { outcome: 'callback_refused', reason: problem, host })
    throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'The callback address is not allowed.', { reason: problem })
  }

  const counted = await context.countCall()
  if (counted.error?.code === 'PT429') refused(counted.error, 'subscribe')

  const id = await subscriptionId([context.userId, context.clientId], url, params.name, args.data)
  const target = {
    user_id: context.userId,
    client_id: context.clientId,
    subscription_id: id,
    project_id: args.data.project_id,
    path: args.data.path ?? null,
    callback_url: url,
  }
  const prepared = await context.rpc('prepare_event_subscription', target)
  if (prepared.error) refused(prepared.error, 'prepare')
  const verified = (prepared.data as { verified?: boolean } | null)?.verified === true

  if (!verified) {
    const started = Date.now()
    const failure = await gate(() => verifyCallback(context.post, url, params.delivery.secret, id))
    if (failure === 'busy') {
      log('challenge', { outcome: 'busy', host })
      throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'Other callbacks are being verified. Try again shortly.', { reason: 'busy' })
    }
    log('challenge', { outcome: failure ? 'failed' : 'verified', ...(failure ?? {}), host, ms: Date.now() - started })
    if (failure) throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'The callback did not answer the verification challenge.', failure)
  } else {
    log('challenge', { outcome: 'cached', host })
  }

  const saved = await context.rpc('save_event_subscription', {
    ...target,
    arguments: args.data,
    secret: params.delivery.secret,
    ttl_ms: params.ttlMs == null ? null : Math.round(params.ttlMs),
    freshly_verified: !verified,
  })
  if (saved.error) refused(saved.error, 'save')
  const expiresAt = (saved.data as { expires_at?: string } | null)?.expires_at
  if (!expiresAt) throw new Error('save failed')
  const refreshBefore = new Date(expiresAt).toISOString()
  log('subscribe', { outcome: 'subscribed', subscription: id, host, refreshBefore })
  return { id, refreshBefore, cursor: null, truncated: false }
}

async function unsubscribe(raw: unknown, context: EventsContext) {
  const parsed = unsubscribeSchema.safeParse(raw)
  if (!parsed.success) invalid('events/unsubscribe needs name, arguments and delivery {url}.')
  const { name, delivery } = parsed.data
  const args = argumentsSchema.safeParse(parsed.data.arguments ?? {})
  // No client, no subscriptions: there is nothing to stop.
  if (!context.clientId) return {}
  const id = await subscriptionId([context.userId, context.clientId], delivery.url, name, args.success ? args.data : parsed.data.arguments ?? {})
  const removed = await context.rpc('delete_event_subscription', { user_id: context.userId, subscription_id: id })
  if (removed.error) refused(removed.error, 'unsubscribe')
  log('unsubscribe', { outcome: 'stopped', subscription: id, host: callbackHost(delivery.url) })
  return {}
}

/** Adds events/list, events/subscribe and events/unsubscribe. The server must declare EVENT_CAPABILITIES. */
export function registerEvents(server: McpServer, context: EventsContext): void {
  const anyParams = { params: z.optional(z.looseObject({})) }
  server.server.setRequestHandler('events/list', anyParams, () => listEvents())
  server.server.setRequestHandler('events/subscribe', anyParams, (params) => subscribe(params, context))
  server.server.setRequestHandler('events/unsubscribe', anyParams, (params) => unsubscribe(params, context))
}

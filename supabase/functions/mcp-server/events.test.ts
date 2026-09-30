import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.19'
import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { Webhook } from 'npm:standardwebhooks@1.1.1'

import { type CallbackResponse, CallbackError } from '../_shared/callbacks.ts'
import { EVENT_CAPABILITIES, type EventsContext, registerEvents } from './events.ts'

// The events methods through the MCP handler, as a 2026-07-28 client such as
// ChatGPT calls them. The database is a stand-in that records each call and
// answers from `answers`; the callback is a stand-in receiver.

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const AGENT = 'a9000000-0000-4000-8000-000000000001'
const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const SECRET = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`
const CALLBACK = 'https://receiver.example.com/mcp-events/callback_1'
const EXPIRES = '2026-10-07T12:00:00.000Z'

type Sent = { url: string; headers: Record<string, string>; body: string }
type Answer = { data: unknown; error: { code?: string; message: string } | null }

/** A receiver that echoes the challenge, unless `answer` says otherwise. */
function receiver(answer?: (body: string) => CallbackResponse | Promise<CallbackResponse>) {
  const sent: Sent[] = []
  const post = async (url: string, headers: Record<string, string>, body: string) => {
    sent.push({ url, headers, body })
    return answer ? await answer(body) : { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }
  }
  return { sent, post }
}

function server(options: { answers?: Record<string, Answer>; clientId?: string | null; post?: EventsContext['post']; limited?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const answers: Record<string, Answer> = {
    prepare_event_subscription: { data: { file_id: null, verified: false }, error: null },
    save_event_subscription: { data: { expires_at: EXPIRES }, error: null },
    delete_event_subscription: { data: null, error: null },
    ...options.answers,
  }
  const context: EventsContext = {
    userId: USER,
    clientId: options.clientId === undefined ? AGENT : options.clientId,
    countCall: () => Promise.resolve({ error: options.limited ? { code: 'PT429', message: 'You have reached the limit of 300 agent tool calls a minute.' } : null }),
    rpc: (fn, args) => {
      calls.push({ fn, args: JSON.parse(JSON.stringify(args)) })
      return Promise.resolve(answers[fn] ?? { data: null, error: null })
    },
    post: options.post ?? receiver().post,
  }
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: EVENT_CAPABILITIES })
    mcp.registerTool('noop', { description: 'A tool, so tools are advertised too.' }, () => ({ content: [] }))
    registerEvents(mcp, context)
    return mcp
  })
  return { handler, calls }
}

let nextId = 1

async function rpc(handler: { fetch(request: Request): Promise<Response> }, method: string, params: Record<string, unknown> = {}) {
  const response = await handler.fetch(
    new Request('https://site.test/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'events-test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
  )
  const text = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').filter((line) => line.startsWith('data:')).at(-1)!.slice(5))
    : JSON.parse(text)
  // deno-lint-ignore no-explicit-any
  return json as { result?: Record<string, any>; error?: { code: number; message: string; data?: Record<string, unknown> } }
}

const subscribeParams = (overrides: { url?: string; secret?: string; args?: Record<string, unknown>; name?: string; ttlMs?: number | null } = {}) => ({
  name: overrides.name ?? 'comment.created',
  arguments: overrides.args ?? { project_id: PROJECT },
  delivery: { mode: 'webhook', url: overrides.url ?? CALLBACK, secret: overrides.secret ?? SECRET },
  cursor: null,
  ...(overrides.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
})

Deno.test('server/discover advertises events next to the tools, and events/list has comment.created', async () => {
  const { handler } = server()
  const discovered = await rpc(handler, 'server/discover')
  assertEquals(discovered.result!.capabilities.events, {})
  assert(discovered.result!.capabilities.tools)

  const { result } = await rpc(handler, 'events/list')
  const [event] = result!.events
  assertEquals(event.name, 'comment.created')
  assertEquals(event.delivery, ['webhook'])
  assertEquals(event.inputSchema.required, ['project_id'])
  assertEquals(event.payloadSchema.required, ['project_id', 'path', 'thread_id', 'comment_id', 'quote', 'text', 'url'])
})

Deno.test('subscribe checks the project, verifies the callback with a signed challenge, then saves it', async () => {
  const { sent, post } = receiver()
  const { handler, calls } = server({ post })
  const { result, error } = await rpc(handler, 'events/subscribe', subscribeParams({ args: { project_id: PROJECT, path: 'notes/plan.md' }, ttlMs: 3_600_000 }))
  assertEquals(error, undefined)
  assertMatch(result!.id, /^sub_[A-Za-z0-9_-]{24}$/)
  assertEquals(result!.refreshBefore, EXPIRES)
  assertEquals(result!.cursor, null)
  assertEquals(result!.truncated, false)

  const [challenge] = sent
  assertEquals(challenge.url, CALLBACK)
  assertEquals(JSON.parse(challenge.body).type, 'verification')
  assertEquals(challenge.headers['X-MCP-Subscription-Id'], result!.id)
  assertMatch(challenge.headers['webhook-id'], /^msg_verification_/)
  new Webhook(SECRET).verify(challenge.body, challenge.headers)

  const target = { user_id: USER, client_id: AGENT, subscription_id: result!.id, project_id: PROJECT, path: 'notes/plan.md', callback_url: CALLBACK }
  assertEquals(calls, [
    { fn: 'prepare_event_subscription', args: target },
    {
      fn: 'save_event_subscription',
      args: { ...target, arguments: { project_id: PROJECT, path: 'notes/plan.md' }, secret: SECRET, ttl_ms: 3_600_000, freshly_verified: true },
    },
  ])
})

Deno.test('a callback this agent verified recently is not challenged again', async () => {
  const { sent, post } = receiver()
  const { handler, calls } = server({ post, answers: { prepare_event_subscription: { data: { file_id: null, verified: true }, error: null } } })
  const { result } = await rpc(handler, 'events/subscribe', subscribeParams())
  assert(result)
  assertEquals(sent.length, 0)
  assertEquals(calls[1].args.freshly_verified, false)
  assertEquals(calls[1].args.ttl_ms, null)
})

Deno.test('a callback that does not echo the challenge fails with CallbackEndpointError, and nothing is saved', async () => {
  const cases: [() => CallbackResponse | Promise<CallbackResponse>, string][] = [
    [() => ({ status: 200, body: JSON.stringify({ challenge: 'something else' }) }), 'challenge_failed'],
    [() => ({ status: 302, body: '' }), 'redirect_refused'],
    [() => ({ status: 500, body: '' }), 'challenge_failed'],
    [() => Promise.reject(new CallbackError('timeout')), 'timeout'],
    [() => Promise.reject(new CallbackError('private_address')), 'private_address'],
  ]
  for (const [answer, reason] of cases) {
    const { post } = receiver(answer)
    const { handler, calls } = server({ post })
    const { error } = await rpc(handler, 'events/subscribe', subscribeParams())
    assertEquals(error?.code, -32015)
    assertEquals(error?.data?.reason, reason)
    assertEquals(calls.map((call) => call.fn), ['prepare_event_subscription'])
  }
})

Deno.test('a callback address that is not allowed is refused before the database or the network', async () => {
  for (const [url, reason] of [
    ['http://receiver.example.com/cb', 'not_https'],
    ['https://10.0.0.1/cb', 'ip_address'],
    ['https://localhost/cb', 'local_host'],
    ['https://elaborat.ing/mcp', 'own_host'],
    ['https://receiver.example.com:8443/cb', 'port_not_allowed'],
  ]) {
    const { sent, post } = receiver()
    const { handler, calls } = server({ post })
    const { error } = await rpc(handler, 'events/subscribe', subscribeParams({ url }))
    assertEquals(error?.code, -32015)
    assertEquals(error?.data?.reason, reason)
    assertEquals(calls, [])
    assertEquals(sent, [])
  }
})

Deno.test('the database refusing (no access, no such file, too many) is invalid params, with no challenge', async () => {
  for (const [code, message] of [['42501', 'Project unavailable'], ['22023', 'No such file in this project'], ['54000', 'A person can have at most 20 event subscriptions']]) {
    const { sent, post } = receiver()
    const { handler, calls } = server({ post, answers: { prepare_event_subscription: { data: null, error: { code, message } } } })
    const { error } = await rpc(handler, 'events/subscribe', subscribeParams())
    assertEquals(error?.code, -32602)
    assertEquals(error?.message.includes(message), true)
    assertEquals(sent, [])
    assertEquals(calls.length, 1)
  }
})

Deno.test('subscribe refuses bad secrets, unknown events, bad arguments, a person without an agent, and a limit reached', async () => {
  const short = `whsec_${btoa('too short')}`
  for (const params of [
    subscribeParams({ secret: 'not-a-secret' }),
    subscribeParams({ secret: short }),
    subscribeParams({ name: 'file.updated' }),
    subscribeParams({ args: { project_id: PROJECT, extra: true } }),
    subscribeParams({ args: { project_id: 'not-a-uuid' } }),
  ]) {
    const { handler, calls } = server()
    const { error } = await rpc(handler, 'events/subscribe', params)
    assertEquals(error?.code, -32602)
    assertEquals(calls, [])
  }
  const person = server({ clientId: null })
  assertEquals((await rpc(person.handler, 'events/subscribe', subscribeParams())).error?.code, -32602)
  assertEquals(person.calls, [])

  const limited = server({ limited: true })
  const { error } = await rpc(limited.handler, 'events/subscribe', subscribeParams())
  assertEquals(error?.code, -32029)
  assertEquals(limited.calls, [])
})

Deno.test('the id is the same whatever the argument order, differs per agent, and unsubscribe stops that one', async () => {
  const first = server()
  const a = await rpc(first.handler, 'events/subscribe', subscribeParams({ args: { project_id: PROJECT, path: 'a.md' } }))
  const b = await rpc(first.handler, 'events/subscribe', subscribeParams({ args: { path: 'a.md', project_id: PROJECT } }))
  assertEquals(a.result!.id, b.result!.id)
  const other = server({ clientId: 'a9000000-0000-4000-8000-000000000002' })
  const c = await rpc(other.handler, 'events/subscribe', subscribeParams({ args: { project_id: PROJECT, path: 'a.md' } }))
  assert(c.result!.id !== a.result!.id)

  const stop = server()
  const { result, error } = await rpc(stop.handler, 'events/unsubscribe', {
    name: 'comment.created',
    arguments: { path: 'a.md', project_id: PROJECT },
    delivery: { mode: 'webhook', url: CALLBACK },
  })
  assertEquals(error, undefined)
  assertEquals(Object.keys(result!).filter((key) => key !== '_meta' && key !== 'resultType'), [])
  assertEquals(stop.calls, [{ fn: 'delete_event_subscription', args: { user_id: USER, subscription_id: a.result!.id } }])
})

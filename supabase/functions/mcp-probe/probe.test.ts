// Temporary host capability probe, remove after testing.
import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Webhook } from 'npm:standardwebhooks@1.1.1'

import { callbackProblem, canonicalJson, forgetVerified, subscriptionId } from './events.ts'
import { createProbeHandler } from './server.ts'
import { PROBE_VIEW_URI } from './view.ts'

// The probe server through its HTTP handler, as a 2026-07-28 client calls it,
// with a stand-in network for the subscriber's callback.

const SECRET = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`
const CALLBACK = 'https://receiver.example.com/mcp-events/callback_1'

type Sent = { url: string; headers: Headers; body: string }

/** A callback that answers each POST with `answer(body)`, recording what it was sent. */
function network(answer: (body: string) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    sent.push({ url: String(input), headers: new Headers(init?.headers), body })
    return await answer(body)
  }) as typeof fetch
  return { sent, fetcher }
}

const echo = (body: string) => Response.json({ challenge: JSON.parse(body).challenge })

function probe(fetcher: typeof fetch) {
  const background: Promise<unknown>[] = []
  forgetVerified()
  const handler = createProbeHandler({ fetch: fetcher, background: (work) => background.push(work), sleep: () => Promise.resolve() })
  return { handler, background }
}

let nextId = 1

async function rpc(handler: (request: Request) => Promise<Response>, method: string, params: Record<string, unknown> = {}, name?: string) {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'probe-test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }
  const response = await handler(
    new Request('https://site.test/mcp-probe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(name ? { 'Mcp-Name': name } : {}),
      },
      body: JSON.stringify(body),
    })
  )
  const text = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').filter((line) => line.startsWith('data:')).at(-1)!.slice(5))
    : JSON.parse(text)
  return json as { result?: Record<string, any>; error?: { code: number; message: string; data?: Record<string, unknown> } }
}

const subscribeParams = (url = CALLBACK, secret = SECRET, args: Record<string, unknown> = { project_id: 'p1' }) => ({
  name: 'comment.created',
  arguments: args,
  delivery: { mode: 'webhook', url, secret },
  cursor: null,
})

Deno.test('server/discover advertises events and tools', async () => {
  const { handler } = probe(network(echo).fetcher)
  const { result } = await rpc(handler, 'server/discover')
  assert(result, 'discover answered')
  assertEquals(result.capabilities.events, {})
  assert(result.capabilities.tools, 'tools advertised')
  assert(result.supportedVersions.includes('2026-07-28'))
})

Deno.test('probe_host has global and thread entrypoints, accepts {} and points at its view', async () => {
  const { handler } = probe(network(echo).fetcher)
  const { result } = await rpc(handler, 'tools/list')
  const tool = result!.tools.find((entry: { name: string }) => entry.name === 'probe_host')
  assertEquals(tool._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }])
  assertEquals(tool._meta.ui.resourceUri, PROBE_VIEW_URI)
  assertEquals(tool.annotations.readOnlyHint, true)

  const call = await rpc(handler, 'tools/call', { name: 'probe_host', arguments: {} }, 'probe_host')
  assertEquals(call.result!.structuredContent.probe, 'elaborat.ing host probe')
  assertEquals(call.result!.structuredContent.protocol_version, '2026-07-28')

  const view = await rpc(handler, 'resources/read', { uri: PROBE_VIEW_URI }, PROBE_VIEW_URI)
  const [content] = view.result!.contents
  assertStringIncludes(content.text, 'https://elaborat.ing/embed-probe')
  assertEquals(content._meta.ui.csp.frameDomains, ['https://elaborat.ing'])
  // The panel's widget domain, declared the same way (mcp-server/tools/panel.ts).
  assertEquals(content._meta['openai/widgetDomain'], 'https://elaborat.ing')
  assertEquals(content._meta.ui.domain, undefined)
  assertStringIncludes(content.text, "If this matches the panel's origin, another app could claim it.")
})

Deno.test('events/list has comment.created with its schemas', async () => {
  const { handler } = probe(network(echo).fetcher)
  const { result } = await rpc(handler, 'events/list')
  assertEquals(result!.events.map((event: { name: string }) => event.name), ['comment.created'])
  assertEquals(result!.events[0].delivery, ['webhook'])
  assertEquals(result!.events[0].inputSchema.required, ['project_id'])
})

Deno.test('subscribe verifies the callback with a signed challenge, then sends one signed sample event', async () => {
  const { sent, fetcher } = network(echo)
  const { handler, background } = probe(fetcher)
  const { result, error } = await rpc(handler, 'events/subscribe', subscribeParams())
  assertEquals(error, undefined)
  assertMatch(result!.id, /^sub_/)
  assertEquals(result!.cursor, null)
  assertEquals(result!.truncated, false)
  assert(Date.parse(result!.refreshBefore) > Date.now())

  const [challenge] = sent
  assertEquals(challenge.url, CALLBACK)
  assertEquals(JSON.parse(challenge.body).type, 'verification')
  assertEquals(challenge.headers.get('X-MCP-Subscription-Id'), result!.id)
  assertMatch(challenge.headers.get('webhook-id')!, /^msg_verification_/)
  // Signed so the standard library accepts it with the subscriber's secret.
  new Webhook(SECRET).verify(challenge.body, Object.fromEntries(challenge.headers))

  await Promise.all(background)
  assertEquals(sent.length, 2)
  const event = JSON.parse(sent[1].body)
  assertEquals(event.name, 'comment.created')
  assertEquals(event.data.project_id, 'p1')
  assertEquals(sent[1].headers.get('webhook-id'), event.eventId)
  new Webhook(SECRET).verify(sent[1].body, Object.fromEntries(sent[1].headers))

  // Subscribing again with the same identity is the same subscription, verified already.
  const again = await rpc(handler, 'events/subscribe', subscribeParams())
  assertEquals(again.result!.id, result!.id)
  assertEquals(sent.length, 2)
})

Deno.test('subscribe refuses a callback that is not https, without calling it', async () => {
  const { sent, fetcher } = network(echo)
  const { handler } = probe(fetcher)
  for (const [url, reason] of [
    ['http://receiver.example.com/cb', 'not_https'],
    ['https://127.0.0.1/cb', 'ip_address'],
    ['https://localhost/cb', 'local_host'],
    ['https://user:pass@receiver.example.com/cb', 'has_credentials'],
  ]) {
    const { error } = await rpc(handler, 'events/subscribe', subscribeParams(url))
    assertEquals(error?.code, -32015)
    assertEquals(error?.data?.reason, reason)
  }
  assertEquals(sent.length, 0)
})

Deno.test('subscribe fails with CallbackEndpointError when the echo is wrong, a redirect or too slow', async () => {
  const cases: ((body: string) => Response)[] = [
    () => Response.json({ challenge: 'something else' }),
    () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com/' } }),
    () => new Response('nope', { status: 500 }),
    () => {
      throw new DOMException('Signal timed out.', 'TimeoutError')
    },
  ]
  const reasons = []
  for (const answer of cases) {
    const { sent, fetcher } = network(answer)
    const { handler, background } = probe(fetcher)
    const { error } = await rpc(handler, 'events/subscribe', subscribeParams())
    assertEquals(error?.code, -32015)
    reasons.push(error?.data?.reason)
    assertEquals(background.length, 0, 'no sample event after a failed verification')
    assertEquals(sent.length, 1)
  }
  assertEquals(reasons, ['challenge_failed', 'redirect_refused', 'challenge_failed', 'timeout'])
})

Deno.test('a batch is refused before any handler runs, so it sends no challenge', async () => {
  const { sent, fetcher } = network(echo)
  const { handler } = probe(fetcher)
  const entry = (id: number) => ({ jsonrpc: '2.0', id, method: 'events/subscribe', params: subscribeParams() })
  const response = await handler(
    new Request('https://site.test/mcp-probe', {
      method: 'POST',
      // The older protocol, which the SDK would otherwise answer batches for.
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
      body: JSON.stringify([entry(1), entry(2), entry(3)]),
    })
  )
  assertEquals(response.status, 400)
  assertEquals((await response.json()).error.code, -32600)
  assertEquals(sent.length, 0)
})

Deno.test('at most two challenges run at once; another subscribe fails as busy without calling out', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const { sent, fetcher } = network(async (body) => {
    await gate
    return echo(body)
  })
  const { handler } = probe(fetcher)
  const calls = [1, 2, 3].map((n) => rpc(handler, 'events/subscribe', subscribeParams(`https://receiver.example.com/cb_${n}`)))
  // Nothing else can finish while the callbacks hang, so the first answer is the refused one.
  const first = await Promise.race(calls)
  assertEquals(first.error?.code, -32015)
  assertEquals(first.error?.data?.reason, 'busy')
  assertEquals(sent.length, 2)
  open()
  const all = await Promise.all(calls)
  assertEquals(all.filter((call) => call.result).length, 2)
})

Deno.test('subscribe refuses bad secrets, unknown events and extra arguments', async () => {
  const { sent, fetcher } = network(echo)
  const { handler } = probe(fetcher)
  const short = `whsec_${btoa('too short')}`
  for (const params of [
    subscribeParams(CALLBACK, 'not-a-secret'),
    subscribeParams(CALLBACK, short),
    { ...subscribeParams(), name: 'file.updated' },
    subscribeParams(CALLBACK, SECRET, { project_id: 'p1', extra: true }),
  ]) {
    const { error } = await rpc(handler, 'events/subscribe', params)
    assertEquals(error?.code, -32602)
  }
  assertEquals(sent.length, 0)
})

Deno.test('unsubscribe answers an empty result', async () => {
  const { handler } = probe(network(echo).fetcher)
  const { result, error } = await rpc(handler, 'events/unsubscribe', { name: 'comment.created', arguments: { project_id: 'p1' }, delivery: { mode: 'webhook', url: CALLBACK } })
  assertEquals(error, undefined)
  // Only the protocol's own fields (result type, server info).
  assertEquals(Object.keys(result!).filter((key) => key !== '_meta' && key !== 'resultType'), [])
})

Deno.test('subscription ids ignore argument key order', async () => {
  assertEquals(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}')
  assertEquals(await subscriptionId(CALLBACK, 'comment.created', { project_id: 'p', path: 'a.md' }), await subscriptionId(CALLBACK, 'comment.created', { path: 'a.md', project_id: 'p' }))
  assert((await subscriptionId(CALLBACK, 'comment.created', { project_id: 'p' })) !== (await subscriptionId(CALLBACK, 'comment.created', { project_id: 'q' })))
  assertEquals(callbackProblem('https://receiver.example.com/cb'), null)
  assertEquals(callbackProblem('https://receiver.example.com:8443/cb'), 'port_not_allowed')
})

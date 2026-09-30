import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19'
import { Webhook } from 'npm:standardwebhooks@1.1.1'

import { CallbackError, type CallbackPolicy, callbackProblem, isPublic, MAX_RESPONSE_BYTES, postToCallback, publicAddresses } from './callbacks.ts'
import { signedHeaders } from './events.ts'
import { chunkedAnswer, fakeNetwork, httpAnswer } from './fakeReceiver.ts'

const POLICY: CallbackPolicy = { ownHosts: ['elaborat.ing', 'project.supabase.co'], allowedHosts: null }
const PUBLIC_A = '93.184.216.34'
const PUBLIC_B = '93.184.216.35'
const SECRET = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))}`

Deno.test('isPublic allows public IPv4 and refuses every special-purpose range, at its edges', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', PUBLIC_A, '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255']) {
    assert(isPublic(address), `${address} is public`)
  }
  for (const address of [
    '0.0.0.0', '0.255.255.255', '10.0.0.1', '10.255.255.255', '100.64.0.0', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.0.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ]) {
    assert(!isPublic(address), `${address} is not public`)
  }
})

Deno.test('isPublic allows only global unicast IPv6, less the special ranges', () => {
  for (const address of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:200::1', '2001:4860:4860::8888', '3fff:1000::1', '2c0f:fb50:4002::1']) {
    assert(isPublic(address), `${address} is public`)
  }
  for (const address of [
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '::127.0.0.1',
    '64:ff9b::808:808', '2001::1', '2001:0:4136:e378::1', '2001:1ff::1', '2001:db8::1', '2002:c000:204::1', '3fff::1', '3fff:fff::1',
    '4000::1', '1fff::1', 'fe80::1%eth0',
  ]) {
    assert(!isPublic(address), `${address} is not public`)
  }
})

Deno.test('isPublic refuses anything that is not an address', () => {
  for (const text of ['', 'example.com', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.256', '0x7f.0.0.1', ':::', '1::2::3', '2001:db8:0:0:0:0:0:0:1', 'g::1']) {
    assert(!isPublic(text), `${JSON.stringify(text)} is refused`)
  }
})

Deno.test('the URL check allows https host names on port 443 and says why it refuses the rest', () => {
  const cases: [string, string | null][] = [
    ['https://receiver.example.com/mcp-events/cb_1?x=1', null],
    ['https://receiver.example.com:443/cb', null],
    ['https://notelaborat.ing/cb', null],
    ['http://receiver.example.com/cb', 'not_https'],
    ['https://user:pass@receiver.example.com/cb', 'has_credentials'],
    ['https://receiver.example.com:8443/cb', 'port_not_allowed'],
    ['https://127.0.0.1/cb', 'ip_address'],
    // Other spellings of 127.0.0.1, which URL writes as dotted decimal.
    ['https://0x7f.1/cb', 'ip_address'],
    ['https://2130706433/cb', 'ip_address'],
    ['https://[::1]/cb', 'ip_address'],
    ['https://localhost/cb', 'local_host'],
    ['https://printer.local/cb', 'local_host'],
    ['https://db.internal/cb', 'local_host'],
    ['https://intranet/cb', 'local_host'],
    ['https://elaborat.ing/mcp', 'own_host'],
    ['https://www.elaborat.ing/cb', 'own_host'],
    ['https://project.supabase.co/functions/v1/send-events', 'own_host'],
    ['not a url', 'not_a_url'],
    [`https://receiver.example.com/${'a'.repeat(2048)}`, 'not_a_url'],
  ]
  for (const [url, expected] of cases) assertEquals(callbackProblem(url, POLICY), expected, url)
})

Deno.test('with an allowlist, only the hosts on it pass, and "none" stops every callback', () => {
  const allow = { ...POLICY, allowedHosts: ['hooks.example.com', '*.chatgpt.com'] }
  assertEquals(callbackProblem('https://hooks.example.com/cb', allow), null)
  assertEquals(callbackProblem('https://api.chatgpt.com/cb', allow), null)
  assertEquals(callbackProblem('https://chatgpt.com.evil.example/cb', allow), 'host_not_allowed')
  assertEquals(callbackProblem('https://other.example.com/cb', allow), 'host_not_allowed')
  assertEquals(callbackProblem('https://hooks.example.com/cb', { ...POLICY, allowedHosts: ['none'] }), 'host_not_allowed')
  // Still never the app itself.
  assertEquals(callbackProblem('https://elaborat.ing/cb', { ...POLICY, allowedHosts: ['elaborat.ing'] }), 'own_host')
})

Deno.test('a host is refused when any of its addresses is not public, or it has none', async () => {
  const mixed = fakeNetwork({ addresses: { A: [PUBLIC_A], AAAA: ['::1'] }, isPublic })
  await assertRejects(() => publicAddresses('receiver.example.com', mixed), CallbackError, 'private_address')
  const none = fakeNetwork({ addresses: {} })
  await assertRejects(() => publicAddresses('receiver.example.com', none), CallbackError, 'unresolvable')
  const good = fakeNetwork({ addresses: { A: [PUBLIC_A], AAAA: ['2606:4700:4700::1111'] }, isPublic })
  assertEquals(await publicAddresses('receiver.example.com', good), [PUBLIC_A, '2606:4700:4700::1111'])
})

Deno.test('a signed POST reaches the checked address, with TLS for the host name, and the receiver verifies it', async () => {
  const network = fakeNetwork({
    addresses: { A: [PUBLIC_A] },
    answer: (request) => {
      new Webhook(SECRET).verify(request.body, request.headers)
      return httpAnswer(200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' })
    },
  })
  const body = JSON.stringify({ eventId: 'evt_1', name: 'comment.created' })
  const answer = await postToCallback('https://receiver.example.com/hooks/1?x=1', signedHeaders(SECRET, 'evt_1', 'sub_1', body), body, { policy: POLICY, network })
  assertEquals(answer, { status: 200, body: '{"ok":true}' })
  assertEquals(network.connected, [PUBLIC_A])
  assertEquals(network.tlsFor, ['receiver.example.com'])
  const [request] = network.requests
  assertEquals(request.requestLine, 'POST /hooks/1?x=1 HTTP/1.1')
  assertEquals(request.headers.host, 'receiver.example.com')
  assertEquals(request.headers['x-mcp-subscription-id'], 'sub_1')
  assertEquals(request.body, body)
  assertEquals(network.closed, [PUBLIC_A])
})

Deno.test('a chunked answer arriving in pieces is read whole', async () => {
  const network = fakeNetwork({ addresses: { A: [PUBLIC_A] }, answer: () => chunkedAnswer(200, ['{"chal', 'lenge":"a', 'b"}']) })
  assertEquals(await postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network }), { status: 200, body: '{"challenge":"ab"}' })
})

Deno.test('a redirect is returned as it is and never followed', async () => {
  const network = fakeNetwork({ addresses: { A: [PUBLIC_A] }, answer: () => httpAnswer(302, '', { Location: 'https://127.0.0.1/' }) })
  const answer = await postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network })
  assertEquals(answer.status, 302)
  assertEquals(network.connected, [PUBLIC_A])
  assertEquals(network.requests.length, 1)
})

Deno.test('a private address is refused before anything connects', async () => {
  for (const addresses of [{ A: ['10.0.0.5'] }, { A: [PUBLIC_A, '169.254.169.254'] }, { AAAA: ['::ffff:127.0.0.1'] }]) {
    const network = fakeNetwork({ addresses, isPublic })
    await assertRejects(() => postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network }), CallbackError, 'private_address')
    assertEquals(network.connected, [])
  }
})

Deno.test('a refused URL is never resolved or connected', async () => {
  const network = fakeNetwork({ addresses: { A: [PUBLIC_A] } })
  const error = await assertRejects(() => postToCallback('https://elaborat.ing/mcp', {}, '{}', { policy: POLICY, network }), CallbackError)
  assertEquals(error.reason, 'own_host')
  assertEquals(network.connected, [])
})

Deno.test('only a failed connection moves on to the next address; a TLS failure does not', async () => {
  const refused = fakeNetwork({ addresses: { A: [PUBLIC_A, PUBLIC_B] }, refuse: [PUBLIC_A] })
  assertEquals((await postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network: refused })).status, 200)
  assertEquals(refused.connected, [PUBLIC_A, PUBLIC_B])

  const badTls = fakeNetwork({ addresses: { A: [PUBLIC_A, PUBLIC_B] }, tlsFails: true })
  const error = await assertRejects(() => postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network: badTls }), CallbackError)
  assertEquals(error.reason, 'tls_failed')
  assertEquals(badTls.connected, [PUBLIC_A])

  const allRefused = fakeNetwork({ addresses: { A: [PUBLIC_A, PUBLIC_B] }, refuse: [PUBLIC_A, PUBLIC_B] })
  const unreachable = await assertRejects(() => postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network: allRefused }), CallbackError)
  assertEquals(unreachable.reason, 'unreachable')
})

Deno.test('one deadline covers the exchange, and the connection is closed when it passes', async () => {
  const network = fakeNetwork({ addresses: { A: [PUBLIC_A] }, answer: () => 'hang' })
  const started = Date.now()
  const error = await assertRejects(() => postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network, deadlineMs: 50 }), CallbackError)
  assertEquals(error.reason, 'timeout')
  assert(Date.now() - started < 2000)
  assert(network.closed.includes(PUBLIC_A))
})

Deno.test('at most 64 KiB of an answer is read', async () => {
  const big = fakeNetwork({ addresses: { A: [PUBLIC_A] }, answer: () => httpAnswer(200, 'x'.repeat(200 * 1024)) })
  const answer = await postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network: big })
  assertEquals(answer.status, 200)
  assert(answer.body.length < MAX_RESPONSE_BYTES)

  const endlessHeaders = fakeNetwork({ addresses: { A: [PUBLIC_A] }, answer: () => [new TextEncoder().encode(`HTTP/1.1 200 OK\r\nX: ${'y'.repeat(100 * 1024)}`)] })
  const error = await assertRejects(() => postToCallback('https://receiver.example.com/cb', {}, '{}', { policy: POLICY, network: endlessHeaders }), CallbackError)
  assertEquals(error.reason, 'response_too_large')
})

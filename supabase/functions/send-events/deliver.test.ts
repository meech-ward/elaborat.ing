import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { Webhook } from 'npm:standardwebhooks@1.1.1'

import { CallbackError, type CallbackResponse, postToCallback } from '../_shared/callbacks.ts'
import { fakeNetwork, httpAnswer, type ReceivedRequest } from '../_shared/fakeReceiver.ts'
import { type Delivery, deliverDue, deliverOne, type EventQueue, MAX_ATTEMPTS, type QueuedEvent, RETRY_DELAYS_S } from './deliver.ts'

// Delivery with a stand-in queue and database, and a stand-in callback: the
// real sender (postToCallback) over a fake network to a fake receiver that
// checks the signature with the Standard Webhooks library.

const secret = (fill: number) => `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)))}`
const SECRET = secret(3)
const OLD_SECRET = secret(4)
const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'

const event = (readCount = 1): QueuedEvent => ({ msgId: 7, readCount, subscriptionId: 'sub_AAAAAAAAAAAAAAAAAAAAAAAA', commentId: 'c1', eventId: 'evt_1' })

const READY: Delivery = {
  deliver: true,
  url: 'https://receiver.example.com/mcp-events/cb_1',
  secrets: [SECRET],
  timestamp: '2026-09-30T20:00:00+00:00',
  data: { project_id: PROJECT, path: 'notes/plan é.md', thread_id: 't1', comment_id: 'c1', quote: 'Rollout', text: 'Add the rollout dates.' },
}

/** A queue holding `events`, answering every delivery check with `delivery`, and recording what happened. */
function queue(delivery: Delivery = READY, events: QueuedEvent[] = [event()]) {
  const done: string[] = []
  const store: EventQueue = {
    read: () => Promise.resolve(events),
    delivery: () => Promise.resolve(delivery),
    finish: (e) => (done.push(`finish ${e.msgId}`), Promise.resolve()),
    retryIn: (e, seconds) => (done.push(`retry ${e.msgId} in ${seconds}`), Promise.resolve()),
    giveUp: (e) => (done.push(`give up ${e.msgId}`), Promise.resolve()),
    endSubscription: (e) => (done.push(`end ${e.subscriptionId}`), Promise.resolve()),
  }
  return { store, done }
}

/** The real sender over a fake network, to a receiver that verifies each signature and answers `status`. */
function callback(status: number | ((request: ReceivedRequest) => number), secrets = [SECRET]) {
  const verified: string[] = []
  const network = fakeNetwork({
    addresses: { A: ['93.184.216.34'] },
    answer: (request) => {
      for (const key of secrets) {
        new Webhook(key).verify(request.body, request.headers)
        verified.push(key)
      }
      return httpAnswer(typeof status === 'number' ? status : status(request))
    },
  })
  const post = (url: string, headers: Record<string, string>, body: string) =>
    postToCallback(url, headers, body, { network, policy: { ownHosts: ['elaborat.ing'], allowedHosts: null } })
  return { post, network, verified }
}

Deno.test('an event is signed so the receiver verifies it, carries the thread and a link, and is removed once accepted', async () => {
  const { store, done } = queue()
  const { post, network, verified } = callback(200)
  assertEquals(await deliverDue(store, post), { delivered: 1, retrying: 0, given_up: 0, dropped: 0, ended: 0 })
  assertEquals(done, ['finish 7'])
  assertEquals(verified, [SECRET])

  const [request] = network.requests
  assertEquals(request.headers['webhook-id'], 'evt_1')
  assertEquals(request.headers['x-mcp-subscription-id'], 'sub_AAAAAAAAAAAAAAAAAAAAAAAA')
  assertEquals(request.headers['content-type'], 'application/json')
  const body = JSON.parse(request.body)
  assertEquals(body, {
    eventId: 'evt_1',
    name: 'comment.created',
    timestamp: '2026-09-30T20:00:00.000Z',
    data: { ...READY.data, url: `https://elaborat.ing/projects/${PROJECT}/notes/plan%20%C3%A9.md` },
    cursor: null,
  })
})

Deno.test('while a replaced secret is still honoured, the event is signed with both', async () => {
  const { store } = queue({ ...READY, secrets: [SECRET, OLD_SECRET] } as Delivery)
  const { post, verified } = callback(200, [SECRET, OLD_SECRET])
  assertEquals((await deliverDue(store, post)).delivered, 1)
  assertEquals(verified, [SECRET, OLD_SECRET])
})

Deno.test('a failed delivery waits longer each time, then is given up after the last attempt', async () => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { store, done } = queue(READY, [event(attempt)])
    const { post } = callback(503)
    const outcome = await deliverOne(event(attempt), store, post)
    if (attempt < MAX_ATTEMPTS) {
      assertEquals(outcome, 'retrying')
      assertEquals(done, [`retry 7 in ${RETRY_DELAYS_S[attempt - 1]}`])
    } else {
      assertEquals(outcome, 'given_up')
      assertEquals(done, ['give up 7'])
    }
  }
  assert(RETRY_DELAYS_S.every((wait, i) => i === 0 || wait > RETRY_DELAYS_S[i - 1]))
})

Deno.test('a redirect is a failure and is not followed; 410 ends the subscription; 413 drops the event', async () => {
  const redirect = callback(302)
  const first = queue()
  assertEquals(await deliverOne(event(), first.store, redirect.post), 'retrying')
  assertEquals(redirect.network.requests.length, 1)

  const gone = queue()
  assertEquals(await deliverOne(event(), gone.store, callback(410).post), 'ended')
  assertEquals(gone.done, ['end sub_AAAAAAAAAAAAAAAAAAAAAAAA'])

  const tooLarge = queue()
  assertEquals(await deliverOne(event(), tooLarge.store, callback(413).post), 'dropped')
  assertEquals(tooLarge.done, ['finish 7'])
})

Deno.test('a callback that now resolves to a private address is a failed delivery, and nothing connects', async () => {
  const network = fakeNetwork({ addresses: { A: ['10.1.2.3'] }, isPublic: (address) => !address.startsWith('10.') })
  const post = (url: string, headers: Record<string, string>, body: string) =>
    postToCallback(url, headers, body, { network, policy: { ownHosts: [], allowedHosts: null } })
  const { store, done } = queue()
  assertEquals(await deliverOne(event(), store, post), 'retrying')
  assertEquals(network.connected, [])
  assertEquals(done, ['retry 7 in 60'])
})

Deno.test('an event the database no longer allows is dropped without being sent', async () => {
  for (const reason of ['not_asked', 'no_access', 'agent_disconnected', 'expired', 'no_subscription']) {
    let posted = 0
    const post = (): Promise<CallbackResponse> => (posted++, Promise.resolve({ status: 200, body: '' }))
    const { store, done } = queue({ deliver: false, reason })
    assertEquals(await deliverOne(event(), store, post), 'dropped')
    assertEquals(posted, 0)
    assertEquals(done, ['finish 7'])
  }
})

Deno.test('an event read more often than it may be tried is given up without a check or a send', async () => {
  let checked = 0
  const { store, done } = queue()
  store.delivery = () => (checked++, Promise.resolve(READY))
  const post = (): Promise<CallbackResponse> => Promise.reject(new CallbackError('timeout'))
  assertEquals(await deliverOne(event(MAX_ATTEMPTS + 1), store, post), 'given_up')
  assertEquals(checked, 0)
  assertEquals(done, ['give up 7'])
})

import { CallbackError, type Post } from '../_shared/callbacks.ts'
import { MAX_EVENT_BYTES, signedHeaders } from '../_shared/events.ts'

// Delivers queued MCP Events. The database queues one message per matching
// subscription when a comment is written (private.queue_comment_events) and
// wakes this function; a pg_cron job wakes it again once a minute while a
// retry is due. Each event is checked again at delivery
// (private.comment_event_delivery), signed with Standard Webhooks and posted
// to its callback through the address-checking sender. A failure waits and
// tries again, with a fresh signature and the same event id, at most
// MAX_ATTEMPTS times; then the event is dropped and the subscription stops
// getting events until its agent subscribes again. 410 and 413 are never
// retried: 410 ends the subscription, 413 drops the event.

/** Attempts per event, the first included. */
export const MAX_ATTEMPTS = 5
/** Seconds to wait after each failed attempt before the next. The sweep looks once a minute. */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200]
/** Events read per run, and how long each stays hidden from other runs while it is sent. */
export const BATCH_SIZE = 10
export const VISIBILITY_S = 120
/** Events posted at once. */
const CONCURRENCY = 5

const APP_ORIGIN = 'https://elaborat.ing'

/** A message from the comment_events queue. `readCount` is this attempt's number. */
export type QueuedEvent = { msgId: number; readCount: number; subscriptionId: string; commentId: string; eventId: string }

export type EventData = { project_id: string; path: string; thread_id: string; comment_id: string; quote: string; text: string }

/** What private.comment_event_delivery answers. */
export type Delivery =
  | { deliver: true; url: string; secrets: string[]; timestamp: string; data: EventData }
  | { deliver: false; reason: string }

/** The queue and the database, or a stand-in in tests. */
export interface EventQueue {
  read(count: number, visibilitySeconds: number): Promise<QueuedEvent[]>
  delivery(event: QueuedEvent): Promise<Delivery>
  /** Removes a delivered or dropped event. */
  finish(event: QueuedEvent): Promise<void>
  /** Hides the event until it is due again. */
  retryIn(event: QueuedEvent, seconds: number): Promise<void>
  /** Removes the event and marks its subscription as failing. */
  giveUp(event: QueuedEvent): Promise<void>
  /** Removes the event and its subscription (the callback answered 410 Gone). */
  endSubscription(event: QueuedEvent): Promise<void>
}

export type Outcome = 'delivered' | 'retrying' | 'given_up' | 'dropped' | 'ended'

/** The file's page in the app, with each path segment percent-encoded. */
export function fileUrl(projectId: string, path: string): string {
  return `${APP_ORIGIN}/projects/${projectId}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** The event body, serialized once: these exact bytes are signed and sent. */
export function eventBody(event: QueuedEvent, delivery: Extract<Delivery, { deliver: true }>): string {
  const { data } = delivery
  return JSON.stringify({
    eventId: event.eventId,
    name: 'comment.created',
    timestamp: new Date(delivery.timestamp).toISOString(),
    data: { ...data, url: fileUrl(data.project_id, data.path) },
    cursor: null,
  })
}

function log(outcome: Outcome, event: QueuedEvent, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ events: 'send-events', outcome, subscription: event.subscriptionId, attempt: event.readCount, ...fields }))
}

async function failed(event: QueuedEvent, queue: EventQueue, fields: Record<string, unknown>): Promise<Outcome> {
  if (event.readCount >= MAX_ATTEMPTS) {
    await queue.giveUp(event)
    log('given_up', event, fields)
    return 'given_up'
  }
  const wait = RETRY_DELAYS_S[Math.min(event.readCount, RETRY_DELAYS_S.length) - 1]
  await queue.retryIn(event, wait)
  log('retrying', event, { ...fields, wait })
  return 'retrying'
}

/** Checks, signs and posts one event, then records what happened. */
export async function deliverOne(event: QueuedEvent, queue: EventQueue, post: Post, now = () => new Date()): Promise<Outcome> {
  // An event read more often than it may be tried (a run that stopped part way, say) is given up.
  if (event.readCount > MAX_ATTEMPTS) {
    await queue.giveUp(event)
    log('given_up', event, { reason: 'attempts' })
    return 'given_up'
  }
  const delivery = await queue.delivery(event)
  if (!delivery.deliver) {
    await queue.finish(event)
    log('dropped', event, { reason: delivery.reason })
    return 'dropped'
  }
  const body = eventBody(event, delivery)
  if (new TextEncoder().encode(body).length > MAX_EVENT_BYTES) {
    await queue.finish(event)
    log('dropped', event, { reason: 'too_large' })
    return 'dropped'
  }
  let status: number
  try {
    ;({ status } = await post(delivery.url, signedHeaders(delivery.secrets, event.eventId, event.subscriptionId, body, now()), body))
  } catch (error) {
    return await failed(event, queue, { reason: error instanceof CallbackError ? error.reason : 'unreachable' })
  }
  if (status >= 200 && status < 300) {
    await queue.finish(event)
    log('delivered', event, { status })
    return 'delivered'
  }
  if (status === 410) {
    await queue.endSubscription(event)
    log('ended', event, { status })
    return 'ended'
  }
  if (status === 413) {
    await queue.finish(event)
    log('dropped', event, { status, reason: 'too_large' })
    return 'dropped'
  }
  // A redirect is never followed, so it is a failure like any other answer.
  return await failed(event, queue, { status })
}

/** Delivers every event that is due now, a few at a time, and counts the outcomes. */
export async function deliverDue(queue: EventQueue, post: Post, now = () => new Date()): Promise<Record<Outcome, number>> {
  const counts: Record<Outcome, number> = { delivered: 0, retrying: 0, given_up: 0, dropped: 0, ended: 0 }
  const events = await queue.read(BATCH_SIZE, VISIBILITY_S)
  let next = 0
  const worker = async () => {
    while (next < events.length) {
      const event = events[next++]
      try {
        counts[await deliverOne(event, queue, post, now)]++
      } catch (error) {
        // A database failure leaves the event hidden; it comes back when its visibility timeout ends.
        console.error(JSON.stringify({ events: 'send-events', outcome: 'error', subscription: event.subscriptionId, message: String(error) }))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, events.length) }, worker))
  return counts
}
